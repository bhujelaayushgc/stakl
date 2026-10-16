package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/bhujelaayushgc/stakl/internal/config"
)

func (s *Server) workspaceRoutes(mux *http.ServeMux) {
	s.workspaceActionRoutes(mux)
	mux.HandleFunc("POST /api/workspaces/{id}/check", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		var payload map[string]json.RawMessage
		if err != nil || (len(bytes.TrimSpace(body)) > 0 && (json.Unmarshal(body, &payload) != nil || len(payload) > 0)) {
			errorJSON(w, fmt.Errorf("check requests cannot supply probe settings"), 400)
			return
		}
		if _, ok := s.Manager.Config().Workspaces[r.PathValue("id")]; !ok {
			errorJSON(w, fmt.Errorf("workspace not found"), 404)
			return
		}
		n, err := s.Workspaces.CheckNow(r.PathValue("id"))
		if err != nil {
			errorJSON(w, err, 503)
			return
		}
		w.WriteHeader(http.StatusAccepted)
		JSON(w, map[string]any{"accepted": true, "scheduled": n})
	})
	mux.HandleFunc("GET /api/workspaces", func(w http.ResponseWriter, r *http.Request) { JSON(w, s.Workspaces.Views()) })
	mux.HandleFunc("GET /api/workspaces/impact", func(w http.ResponseWriter, r *http.Request) {
		controller, app := r.URL.Query().Get("controller"), r.URL.Query().Get("app")
		if !config.ValidController(controller) || !config.ValidID(app) {
			errorJSON(w, fmt.Errorf("valid controller and app are required"), 400)
			return
		}
		JSON(w, s.Workspaces.Impact(controller, app))
	})
	mux.HandleFunc("GET /api/workspaces/{id}", func(w http.ResponseWriter, r *http.Request) {
		for _, v := range s.Workspaces.Views() {
			if v.ID == r.PathValue("id") {
				JSON(w, v)
				return
			}
		}
		errorJSON(w, fmt.Errorf("workspace not found"), 404)
	})
}
