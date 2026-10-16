package workspaces

import "github.com/bhujelaayushgc/stakl/internal/manager"

type Actions struct {
	Start  bool   `json:"start"`
	Stop   bool   `json:"stop"`
	Reason string `json:"reason"`
}

func memberActions(m Member, app manager.AppView) Actions {
	if !m.ObservationFresh {
		return Actions{Reason: m.Reason}
	}
	if m.Host == nil || m.Host.Access != "control" {
		return Actions{Reason: "Read-only access"}
	}
	if app.Config.Type == "external" || app.EffectiveConfig.Type == "external" {
		return Actions{Reason: "Observation only; use the service's existing manager"}
	}
	switch app.Runtime.State {
	case "stopped", "failed":
		return Actions{Start: true}
	case "running", "healthy", "unhealthy", "external":
		if app.Runtime.Owned || (app.EffectiveConfig.Type == "custom" && app.EffectiveConfig.Stop.Command != "") {
			return Actions{Stop: true, Reason: "Already running"}
		}
		return Actions{Reason: "Service is running outside Stakl's lifecycle control"}
	default:
		return Actions{Reason: "Wait for a fresh, stable service observation"}
	}
}
