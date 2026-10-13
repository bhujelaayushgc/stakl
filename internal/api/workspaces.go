package api

import (
	"fmt"
	"net/http"

	"github.com/bhujelaayushgc/stakl/internal/config"
)

func (s *Server) workspaceRoutes(mux *http.ServeMux) {
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
