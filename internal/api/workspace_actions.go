package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/bhujelaayushgc/stakl/internal/config"
	"github.com/bhujelaayushgc/stakl/internal/hosts"
	"github.com/bhujelaayushgc/stakl/internal/manager"
	"github.com/bhujelaayushgc/stakl/internal/workspaces"
)

type WorkspaceActionResult struct {
	Alias      string `json:"alias"`
	Controller string `json:"controller"`
	App        string `json:"app"`
	Name       string `json:"name"`
	Action     string `json:"action"`
	Status     string `json:"status"`
	Message    string `json:"message"`
}

type WorkspaceOperation struct {
	Workspace string                  `json:"workspace"`
	Action    string                  `json:"action"`
	Results   []WorkspaceActionResult `json:"results"`
}

func workspaceActionBody(r *http.Request, allowShared bool) (bool, string, error) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 8193))
	if err != nil || len(body) > 8192 {
		return false, "", fmt.Errorf("invalid workspace action request")
	}
	if len(bytes.TrimSpace(body)) == 0 {
		return false, "", nil
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(body, &fields) != nil || fields == nil {
		return false, "", fmt.Errorf("workspace action settings must be an object")
	}
	confirmed := false
	revision := ""
	for key, value := range fields {
		if key == "revision" {
			if string(bytes.TrimSpace(value)) == "null" || json.Unmarshal(value, &revision) != nil {
				return false, "", fmt.Errorf("revision must be a string")
			}
			continue
		}
		if key != "confirm_shared" || !allowShared {
			return false, "", fmt.Errorf("workspace actions cannot supply target or execution settings")
		}
		if string(bytes.TrimSpace(value)) != "true" && string(bytes.TrimSpace(value)) != "false" {
			return false, "", fmt.Errorf("confirm_shared must be a boolean")
		}
		confirmed = string(bytes.TrimSpace(value)) == "true"
	}
	return confirmed, revision, nil
}

func (s *Server) workspaceActionRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/workspaces/{id}/start", func(w http.ResponseWriter, r *http.Request) {
		r.SetPathValue("action", "start")
		s.workspaceAction(w, r)
	})
	mux.HandleFunc("POST /api/workspaces/{id}/members/{member}/{action}", s.workspaceAction)
}

func (s *Server) workspaceView(id string) (workspaces.View, bool) {
	for _, v := range s.Workspaces.Views() {
		if v.ID == id {
			return v, true
		}
	}
	return workspaces.View{}, false
}

func (s *Server) workspaceAction(w http.ResponseWriter, r *http.Request) {
	id, alias, action := r.PathValue("id"), r.PathValue("member"), r.PathValue("action")
	if action != "start" && (action != "stop" || alias == "") {
		errorJSON(w, fmt.Errorf("unsupported workspace action"), 400)
		return
	}
	confirmed, revision, err := workspaceActionBody(r, action == "stop")
	if err != nil {
		errorJSON(w, err, 400)
		return
	}
	c := s.Manager.Config()
	view, ok := s.workspaceView(id)
	if !ok {
		errorJSON(w, fmt.Errorf("workspace not found"), 404)
		return
	}
	if revision != "" && revision != view.Revision {
		errorJSON(w, fmt.Errorf("workspace configuration changed; refresh before operating"), http.StatusConflict)
		return
	}
	members := view.Members
	if alias != "" {
		members = nil
		for _, m := range view.Members {
			if m.Alias == alias {
				members = []workspaces.Member{m}
				break
			}
		}
		if len(members) == 0 {
			errorJSON(w, fmt.Errorf("workspace member not found"), 404)
			return
		}
		m := members[0]
		if (action == "start" && !m.Actions.Start && m.Actions.Reason != "Already running") || (action == "stop" && !m.Actions.Stop) {
			errorJSON(w, fmt.Errorf("%s", m.Actions.Reason), 409)
			return
		}
		if action == "stop" && !confirmed {
			for _, use := range m.Uses {
				if use.ID != id {
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusConflict)
					JSON(w, map[string]any{"error": "Shared service stop requires confirmation of affected workspaces", "uses": m.Uses})
					return
				}
			}
		}
	}
	s.workspaceActionMu.Lock()
	if s.workspaceActions[id] {
		s.workspaceActionMu.Unlock()
		errorJSON(w, fmt.Errorf("a workspace action is already in progress"), 409)
		return
	}
	if s.workspaceActions == nil {
		s.workspaceActions = map[string]bool{}
	}
	s.workspaceActions[id] = true
	s.workspaceActionMu.Unlock()
	defer func() { s.workspaceActionMu.Lock(); delete(s.workspaceActions, id); s.workspaceActionMu.Unlock() }()
	op := WorkspaceOperation{Workspace: id, Action: action, Results: make([]WorkspaceActionResult, 0, len(members))}
	for _, original := range members {
		result := WorkspaceActionResult{Alias: original.Alias, Controller: original.Controller, App: original.App, Name: original.Name, Action: action, Status: "skipped"}
		if s.Manager.Config() != c {
			result.Message = "Configuration changed; refresh before operating"
			op.Results = append(op.Results, result)
			continue
		}
		if r.Context().Err() != nil {
			result.Message = "Operation canceled; inspect current service state"
			op.Results = append(op.Results, result)
			continue
		}
		latest, exists := s.workspaceView(id)
		m := original
		found := false
		if exists {
			for _, candidate := range latest.Members {
				if candidate.Alias == original.Alias {
					m = candidate
					found = true
					break
				}
			}
		}
		if !found || s.Manager.Config() != c || m.Controller != original.Controller || m.App != original.App {
			result.Message = "Workspace member is unavailable"
			op.Results = append(op.Results, result)
			continue
		}
		allowed := m.Actions.Start
		if action == "stop" {
			allowed = m.Actions.Stop
		}
		if !allowed {
			result.Message = m.Actions.Reason
			if action == "start" && m.ObservationFresh && workspaceRunning(m.RuntimeState) {
				result.Status = "already_running"
			}
			op.Results = append(op.Results, result)
			continue
		}
		result = s.dispatchWorkspaceAction(r, c, m, action, result)
		op.Results = append(op.Results, result)
	}
	if action == "start" && s.Manager.Config() == c && r.Context().Err() == nil {
		_, _ = s.Workspaces.CheckNow(id)
	}
	JSON(w, op)
}

func workspaceRunning(state string) bool {
	switch state {
	case "running", "healthy", "unhealthy", "external":
		return true
	}
	return false
}

func (s *Server) dispatchWorkspaceAction(r *http.Request, c *config.Config, m workspaces.Member, action string, result WorkspaceActionResult) WorkspaceActionResult {
	var outcomes map[string]string
	var err error
	uncertain := false
	if m.Host.ID == "local" {
		var operation manager.OperationResult
		operation, err = s.Manager.OperateWithConfig(r.Context(), action, []string{m.App}, false, c)
		outcomes, uncertain = operation.Results, operation.OutcomeUnknown
	} else if s.Hosts != nil {
		var response hosts.PeerActionResult
		response, err = s.Hosts.OperateController(r.Context(), m.Host.ID, m.Controller, m.App, action)
		outcomes = response.Results
		// Older peers cannot distinguish a definite failure from an unverified
		// launch. Preserve that uncertainty without parsing diagnostic strings.
		uncertain = err == nil && response.OutcomeUnknown == nil && outcomes[m.App] != "ok"
	} else {
		err = fmt.Errorf("host registry unavailable")
	}
	var peerErr *hosts.HostError
	if uncertain || (errors.As(err, &peerErr) && peerErr.OutcomeUnknown) || r.Context().Err() != nil {
		result.Status, result.Message = "outcome_unknown", "Outcome unknown; inspect service state before deciding whether to retry"
	} else if s.Manager.Config() != c && err != nil {
		result.Status, result.Message = "skipped", "Configuration changed; refresh before operating"
	} else if err != nil || outcomes[m.App] != "ok" || outcomes["error"] != "" {
		result.Status, result.Message = "failed", "Action failed; inspect the service details and Activity"
	} else {
		result.Status, result.Message = "started", "Start completed; readiness is checked separately"
		if action == "stop" {
			result.Status, result.Message = "stopped", "Stop completed"
		}
	}
	return result
}
