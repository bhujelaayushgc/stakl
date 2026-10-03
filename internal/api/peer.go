package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"runtime"
	"strings"
	"time"

	"github.com/bhujelaayushgc/stakl/internal/hosts"
	"github.com/bhujelaayushgc/stakl/internal/storage"
)

type peerGrantKey struct{}
type peerStream struct{ cancel context.CancelFunc }

func (s *Server) peerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/peer/v1/info", func(w http.ResponseWriter, r *http.Request) { JSON(w, s.peerInfo(r)) })
	mux.HandleFunc("GET /api/peer/v1/snapshot", func(w http.ResponseWriter, r *http.Request) {
		JSON(w, hosts.Snapshot{Info: s.peerInfo(r), Groups: s.Manager.Config().Groups, Apps: s.Manager.Views()})
	})
	mux.HandleFunc("GET /api/peer/v1/apps/{id}", s.app)
	mux.HandleFunc("GET /api/peer/v1/apps/{id}/health", func(w http.ResponseWriter, r *http.Request) {
		if s.peerAppExists(w, r) {
			JSON(w, s.Manager.Store.Checks(r.PathValue("id")))
		}
	})
	mux.HandleFunc("GET /api/peer/v1/apps/{id}/history", func(w http.ResponseWriter, r *http.Request) {
		if s.peerAppExists(w, r) {
			JSON(w, s.Manager.Store.History(r.PathValue("id")))
		}
	})
	mux.HandleFunc("GET /api/peer/v1/apps/{id}/logs", s.peerLogs)
	for _, action := range []string{"start", "stop", "restart"} {
		mux.HandleFunc("POST /api/peer/v1/apps/{id}/"+action, func(w http.ResponseWriter, r *http.Request) {
			if s.peerInfo(r).Access != "control" {
				errorJSON(w, fmt.Errorf("control access required"), http.StatusForbidden)
				return
			}
			if r.Header.Get("X-Stakl-Peer-ID") != s.ControllerID {
				errorJSON(w, fmt.Errorf("controller identity mismatch"), http.StatusConflict)
				return
			}
			if !s.peerAppExists(w, r) {
				return
			}
			JSON(w, hosts.LifecycleResponse{Info: s.peerInfo(r), Results: s.Manager.Operate(r.Context(), action, []string{r.PathValue("id")}, false)})
		})
	}
	mux.HandleFunc("GET /api/peer-tokens", func(w http.ResponseWriter, r *http.Request) {
		grants, err := s.Manager.Store.PeerGrants()
		if err != nil {
			errorJSON(w, err, http.StatusInternalServerError)
			return
		}
		JSON(w, grants)
	})
	mux.HandleFunc("POST /api/peer-tokens", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Name   string `json:"name"`
			Access string `json:"access"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			errorJSON(w, err, http.StatusBadRequest)
			return
		}
		if in.Access == "" {
			in.Access = "read"
		}
		if strings.TrimSpace(in.Name) == "" || (in.Access != "read" && in.Access != "control") {
			errorJSON(w, fmt.Errorf("grant requires a name and read or control access"), http.StatusBadRequest)
			return
		}
		grant, token, err := s.Manager.Store.IssuePeerGrant(in.Name, in.Access)
		if err != nil {
			errorJSON(w, err, http.StatusInternalServerError)
			return
		}
		JSON(w, struct {
			storage.PeerGrant
			Token string `json:"token"`
		}{grant, token})
	})
	mux.HandleFunc("POST /api/peer-tokens/{id}/revoke", s.revokePeerGrant)
}

func (s *Server) peerInfo(r *http.Request) hosts.Info {
	grant := r.Context().Value(peerGrantKey{}).(storage.PeerGrant)
	return hosts.Info{ControllerID: s.ControllerID, Protocol: 1, Version: s.Version, Platform: runtime.GOOS + "/" + runtime.GOARCH, Access: grant.Access}
}

func (s *Server) peerAppExists(w http.ResponseWriter, r *http.Request) bool {
	if _, ok := s.Manager.View(r.PathValue("id")); !ok {
		errorJSON(w, fmt.Errorf("app not found"), http.StatusNotFound)
		return false
	}
	return true
}

func (s *Server) authenticatePeer(w http.ResponseWriter, r *http.Request) (*http.Request, bool) {
	if r.TLS == nil {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		ip := net.ParseIP(host)
		if err != nil || ip == nil || !ip.IsLoopback() {
			errorJSON(w, fmt.Errorf("peer authentication requires TLS or loopback transport"), http.StatusForbidden)
			return r, false
		}
	}
	if s.controllerErr != nil {
		errorJSON(w, s.controllerErr, http.StatusInternalServerError)
		return r, false
	}
	var token string
	if strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
		token = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	}
	grant, ok, err := s.Manager.Store.AuthenticatePeer(token)
	if err != nil {
		errorJSON(w, err, http.StatusInternalServerError)
		return r, false
	}
	if !ok {
		errorJSON(w, fmt.Errorf("invalid peer credential"), http.StatusUnauthorized)
		return r, false
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != scheme+"://"+r.Host {
		errorJSON(w, fmt.Errorf("cross-origin request refused"), http.StatusForbidden)
		return r, false
	}
	if r.Method != http.MethodGet && r.Header.Get("X-Stakl") != "1" {
		errorJSON(w, fmt.Errorf("X-Stakl header required"), http.StatusForbidden)
		return r, false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 2*1024*1024)
	return r.WithContext(context.WithValue(r.Context(), peerGrantKey{}, grant)), true
}

func (s *Server) peerLogs(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("follow") != "true" || r.URL.Query().Get("download") == "true" {
		s.logs(w, r)
		return
	}
	if !s.peerAppExists(w, r) {
		return
	}
	grant := r.Context().Value(peerGrantKey{}).(storage.PeerGrant)
	s.peerMu.Lock()
	// Registration and revocation share this lock so a request authenticated
	// before revocation cannot install a stream after revocation has completed.
	_, ok, err := s.Manager.Store.AuthenticatePeer(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	closed := s.peerClosed
	if err != nil || !ok || closed {
		s.peerMu.Unlock()
		if err != nil {
			errorJSON(w, err, http.StatusInternalServerError)
		} else if closed {
			errorJSON(w, fmt.Errorf("peer streams closed"), http.StatusServiceUnavailable)
		} else {
			errorJSON(w, fmt.Errorf("invalid peer credential"), http.StatusUnauthorized)
		}
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	stream := &peerStream{cancel: cancel}
	if s.peerStreams == nil {
		s.peerStreams = make(map[string]map[*peerStream]struct{})
	}
	if s.peerStreams[grant.ID] == nil {
		s.peerStreams[grant.ID] = make(map[*peerStream]struct{})
	}
	s.peerStreams[grant.ID][stream] = struct{}{}
	s.peerMu.Unlock()
	writeCanceled := make(chan struct{})
	stopWriteCancellation := context.AfterFunc(ctx, func() {
		// A canceled context alone cannot interrupt a blocked network write.
		// Expiring the response deadline wakes it and closes the stream.
		http.NewResponseController(w).SetWriteDeadline(time.Now())
		close(writeCanceled)
	})
	defer func() {
		if !stopWriteCancellation() {
			<-writeCanceled
		}
		cancel()
		s.peerMu.Lock()
		delete(s.peerStreams[grant.ID], stream)
		if len(s.peerStreams[grant.ID]) == 0 {
			delete(s.peerStreams, grant.ID)
		}
		s.peerMu.Unlock()
	}()
	s.logs(w, r.WithContext(ctx))
}

func (s *Server) revokePeerGrant(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	s.peerMu.Lock()
	if err := s.Manager.Store.RevokePeerGrant(id); err != nil {
		s.peerMu.Unlock()
		errorJSON(w, err, http.StatusInternalServerError)
		return
	}
	for stream := range s.peerStreams[id] {
		stream.cancel()
	}
	delete(s.peerStreams, id)
	s.peerMu.Unlock()
	JSON(w, map[string]bool{"ok": true})
}

// CancelPeerStreams closes peer follow streams when the controller shuts down.
func (s *Server) CancelPeerStreams() {
	s.peerMu.Lock()
	defer s.peerMu.Unlock()
	s.peerClosed = true
	for _, streams := range s.peerStreams {
		for stream := range streams {
			stream.cancel()
		}
	}
	s.peerStreams = nil
}
