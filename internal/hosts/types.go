package hosts

import (
	"github.com/bhujelaayushgc/stakl/internal/config"
	"github.com/bhujelaayushgc/stakl/internal/manager"
)

type Info struct {
	ControllerID string `json:"controller_id"`
	Protocol     int    `json:"protocol"`
	Version      string `json:"version"`
	Platform     string `json:"platform"`
	Access       string `json:"access"`
}

type Snapshot struct {
	Info   Info                    `json:"info"`
	Groups map[string]config.Group `json:"groups"`
	Apps   []manager.AppView       `json:"apps"`
}

type LifecycleResponse struct {
	Info    Info              `json:"info"`
	Results map[string]string `json:"results"`
}
