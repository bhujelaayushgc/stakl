package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/bhujelaayushgc/stakl/internal/peeraccess"
)

// PeerHandler exposes scoped peer routes using this server's grants and stream
// tracking, with immutable Host validation specific to the second listener.
func (s *Server) PeerHandler(address string) http.Handler {
	s.initController()
	mux := http.NewServeMux()
	s.peerDataRoutes(mux)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		w.Header().Set("Cache-Control", "no-store")
		if r.Host != address {
			errorJSON(w, fmt.Errorf("unrecognized host"), 403)
			return
		}
		if !strings.HasPrefix(r.URL.Path, "/api/peer/v1/") {
			http.NotFound(w, r)
			return
		}
		peerRequest, ok := s.authenticatePeer(w, r)
		if ok {
			mux.ServeHTTP(w, peerRequest)
		}
	})
}

type peerAccessStatus struct {
	peeraccess.Status
	PrimaryNetworkAccess bool `json:"primary_network_access"`
}

func (s *Server) setupStatus() peerAccessStatus {
	return peerAccessStatus{Status: s.PeerAccess.Status(), PrimaryNetworkAccess: s.Certificate != nil && peeraccess.NetworkBound(s.BindHost)}
}
func (s *Server) peerAccessRoutes(mux *http.ServeMux) {
	available := func(w http.ResponseWriter) bool {
		if s.PeerAccess == nil {
			errorJSON(w, fmt.Errorf("host access setup is unavailable in this controller"), 503)
			return false
		}
		return true
	}
	mux.HandleFunc("GET /api/peer-access", func(w http.ResponseWriter, r *http.Request) {
		if available(w) {
			JSON(w, s.setupStatus())
		}
	})
	mux.HandleFunc("POST /api/peer-access/enable", func(w http.ResponseWriter, r *http.Request) {
		if !available(w) {
			return
		}
		var request peeraccess.EnableRequest
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
		decoder.DisallowUnknownFields()
		err := decoder.Decode(&request)
		if err == nil {
			var extra any
			if decoder.Decode(&extra) != io.EOF {
				err = fmt.Errorf("invalid trailing request data")
			}
		}
		if err != nil || len(request.Address) > 64 {
			errorJSON(w, fmt.Errorf("provide a network IP address, a port, and optional certificate replacement"), 400)
			return
		}
		if _, err := s.PeerAccess.Enable(r.Context(), request); err != nil {
			setupError(w, err)
			return
		}
		JSON(w, s.setupStatus())
	})
	mux.HandleFunc("POST /api/peer-access/disable", func(w http.ResponseWriter, r *http.Request) {
		if !available(w) {
			return
		}
		if _, err := s.PeerAccess.Disable(); err != nil {
			setupError(w, err)
			return
		}
		JSON(w, s.setupStatus())
	})
}
func setupError(w http.ResponseWriter, err error) {
	var failure *peeraccess.Failure
	if errors.As(err, &failure) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(failure.Status)
		JSON(w, map[string]string{"error": failure.Message, "code": failure.Code})
		return
	}
	errorJSON(w, fmt.Errorf("could not update host access"), 500)
}
