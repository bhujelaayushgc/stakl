package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/bhujelaayushgc/stakl/internal/hosts"
)

func (s *Server) hostRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/hosts", func(w http.ResponseWriter, r *http.Request) {
		descriptions := []hosts.Description{s.localHost()}
		if s.Hosts != nil {
			descriptions = append(descriptions, s.Hosts.Descriptions()...)
		}
		JSON(w, descriptions)
	})
	mux.HandleFunc("GET /api/hosts/apps", func(w http.ResponseWriter, r *http.Request) {
		snapshots := []hosts.Envelope{{Host: s.localHost(), Groups: s.Manager.Config().Groups, Apps: s.Manager.Views()}}
		if s.Hosts != nil {
			snapshots = append(snapshots, s.Hosts.Snapshots()...)
		}
		JSON(w, snapshots)
	})
	mux.HandleFunc("POST /api/hosts", func(w http.ResponseWriter, r *http.Request) {
		if !s.requireHosts(w) {
			return
		}
		var input hosts.HostInput
		if json.NewDecoder(r.Body).Decode(&input) != nil {
			errorJSON(w, fmt.Errorf("invalid host registration"), 400)
			return
		}
		host, err := s.Hosts.Register(r.Context(), input)
		if err != nil {
			hostError(w, err)
			return
		}
		JSON(w, host)
	})
	mux.HandleFunc("POST /api/hosts/{host}/update", func(w http.ResponseWriter, r *http.Request) {
		if !s.requireHosts(w) {
			return
		}
		var patch hosts.HostPatch
		if json.NewDecoder(r.Body).Decode(&patch) != nil {
			errorJSON(w, fmt.Errorf("invalid host update"), 400)
			return
		}
		host, err := s.Hosts.Update(r.Context(), r.PathValue("host"), patch)
		if err != nil {
			hostError(w, err)
			return
		}
		JSON(w, host)
	})
	mux.HandleFunc("POST /api/hosts/{host}/reconnect", func(w http.ResponseWriter, r *http.Request) {
		if !s.requireHosts(w) {
			return
		}
		if err := s.Hosts.Reconnect(r.Context(), r.PathValue("host")); err != nil {
			hostError(w, err)
			return
		}
		host, _ := s.hostDescription(r.PathValue("host"))
		JSON(w, host)
	})
	mux.HandleFunc("POST /api/hosts/{host}/remove", func(w http.ResponseWriter, r *http.Request) {
		if !s.requireHosts(w) {
			return
		}
		if r.PathValue("host") == "local" {
			errorJSON(w, fmt.Errorf("cannot remove local host"), 400)
			return
		}
		if err := s.Hosts.Remove(r.PathValue("host")); err != nil {
			hostError(w, err)
			return
		}
		JSON(w, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /api/hosts/{host}/apps/{app}", s.hostRead)
	for _, resource := range []string{"health", "history", "logs"} {
		mux.HandleFunc("GET /api/hosts/{host}/apps/{app}/"+resource, func(w http.ResponseWriter, r *http.Request) { r.SetPathValue("resource", resource); s.hostRead(w, r) })
	}
	for _, action := range []string{"start", "stop", "restart"} {
		mux.HandleFunc("POST /api/hosts/{host}/apps/{app}/"+action, func(w http.ResponseWriter, r *http.Request) { r.SetPathValue("action", action); s.hostAction(w, r) })
	}
}

func (s *Server) localHost() hosts.Description {
	return hosts.Description{ID: "local", ControllerID: s.ControllerID, Name: "Local", Access: "control", State: hosts.StateOnline, LastSeen: time.Now().UTC()}
}
func (s *Server) hostDescription(id string) (hosts.Description, bool) {
	if id == "local" {
		return s.localHost(), true
	}
	if s.Hosts != nil {
		for _, host := range s.Hosts.Descriptions() {
			if host.ID == id {
				return host, true
			}
		}
	}
	return hosts.Description{}, false
}
func (s *Server) requireHosts(w http.ResponseWriter) bool {
	if s.Hosts != nil {
		return true
	}
	errorJSON(w, fmt.Errorf("host registry is unavailable"), http.StatusServiceUnavailable)
	return false
}
func hostError(w http.ResponseWriter, err error) {
	status := http.StatusBadGateway
	message := "Peer request failed"
	var hostErr *hosts.HostError
	unknown := false
	var state hosts.ConnectionState
	if errors.As(err, &hostErr) {
		message = hostErr.Message
		state = hostErr.State
		unknown = hostErr.OutcomeUnknown
		if hostErr.StatusCode >= 400 && hostErr.StatusCode <= 599 {
			status = hostErr.StatusCode
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	JSON(w, struct {
		Error          string                `json:"error"`
		State          hosts.ConnectionState `json:"state,omitempty"`
		OutcomeUnknown bool                  `json:"outcome_unknown"`
	}{message, state, unknown})
}
func hostJSON(w http.ResponseWriter, host hosts.Description, data any) {
	JSON(w, struct {
		Host hosts.Description `json:"host"`
		Data any               `json:"data"`
	}{host, data})
}

func (s *Server) hostAction(w http.ResponseWriter, r *http.Request) {
	host, ok := s.hostDescription(r.PathValue("host"))
	if !ok {
		errorJSON(w, fmt.Errorf("host not found"), 404)
		return
	}
	app, action := r.PathValue("app"), r.PathValue("action")
	if host.ID == "local" {
		if _, ok := s.Manager.View(app); !ok {
			errorJSON(w, fmt.Errorf("app not found"), 404)
			return
		}
		hostJSON(w, host, s.Manager.Operate(r.Context(), action, []string{app}, false))
		return
	}
	result, err := s.Hosts.Operate(r.Context(), host.ID, app, action)
	if err != nil {
		hostError(w, err)
		return
	}
	if latest, ok := s.hostDescription(host.ID); ok {
		host = latest
	}
	hostJSON(w, host, result.Results)
}

func (s *Server) hostRead(w http.ResponseWriter, r *http.Request) {
	host, ok := s.hostDescription(r.PathValue("host"))
	if !ok {
		errorJSON(w, fmt.Errorf("host not found"), 404)
		return
	}
	app, resource := r.PathValue("app"), r.PathValue("resource")
	if resource == "" {
		resource = "app"
	}
	stream := resource == "logs" && (r.URL.Query().Get("follow") == "true" || r.URL.Query().Get("download") == "true")
	if host.ID == "local" {
		view, ok := s.Manager.View(app)
		if !ok {
			errorJSON(w, fmt.Errorf("app not found"), 404)
			return
		}
		if stream {
			w.Header().Set("X-Stakl-Host-ID", host.ID)
			r.SetPathValue("id", app)
			s.logs(w, r)
			return
		}
		switch resource {
		case "app":
			hostJSON(w, host, view)
		case "health":
			hostJSON(w, host, s.Manager.Store.Checks(app))
		case "history":
			hostJSON(w, host, s.Manager.Store.History(app))
		case "logs":
			limit := 1000
			if n, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && n > 0 && n <= 10000 {
				limit = n
			}
			hostJSON(w, host, s.Manager.Logs(app, limit, time.Time{}))
		}
		return
	}
	response, err := s.Hosts.ReadApp(r.Context(), host.ID, app, resource, r.URL.Query(), r.Header.Get("Last-Event-ID"))
	if err != nil {
		hostError(w, err)
		return
	}
	defer response.Body.Close()
	if stream {
		forwardHostStream(w, r, response, host.ID)
		return
	}
	// Buffer bounded JSON before sending any browser headers so invalid or partial
	// upstream responses cannot masquerade as a successful envelope.
	data, err := io.ReadAll(response.Body)
	if err != nil {
		hostError(w, err)
		return
	}
	if !json.Valid(data) {
		hostError(w, fmt.Errorf("invalid peer JSON"))
		return
	}
	hostJSON(w, host, json.RawMessage(data))
}

func forwardHostStream(w http.ResponseWriter, r *http.Request, response *http.Response, hostID string) {
	// The peer client's context also expires on idle timeout and host removal.
	// Expiring a downstream write deadline makes cancellation effective even when
	// the browser has stopped reading and the network write is blocked.
	stopped := make(chan struct{})
	stop := context.AfterFunc(response.Request.Context(), func() {
		http.NewResponseController(w).SetWriteDeadline(time.Now())
		close(stopped)
	})
	var finishOnce sync.Once
	finishCancellation := func() {
		finishOnce.Do(func() {
			if !stop() {
				<-stopped
			}
		})
	}
	defer finishCancellation()
	for _, header := range []string{"Content-Type", "Content-Disposition"} {
		if value := response.Header.Get(header); value != "" {
			w.Header().Set(header, value)
		}
	}
	w.Header().Set("X-Stakl-Host-ID", hostID)
	follow := r.URL.Query().Get("follow") == "true" && r.URL.Query().Get("download") != "true"
	controller := http.NewResponseController(w)
	w.WriteHeader(http.StatusOK)
	if follow {
		if controller.Flush() != nil {
			return
		}
	}
	buffer := make([]byte, 32*1024)
	for {
		n, err := response.Body.Read(buffer)
		if n > 0 {
			if _, writeErr := w.Write(buffer[:n]); writeErr != nil {
				return
			}
			if follow {
				if controller.Flush() != nil {
					return
				}
			}
		}
		if err != nil {
			if follow && r.Context().Err() == nil {
				// Join the cancellation callback before granting a bounded final
				// write window. An expired upstream deadline must not suppress
				// the named error to a browser that is still reading.
				finishCancellation()
				controller.SetWriteDeadline(time.Now().Add(time.Second))
				fmt.Fprint(w, "\n\nevent: connection-error\ndata: {\"error\":\"Peer log connection closed\"}\n\n")
				controller.Flush()
			}
			return
		}
	}
}
