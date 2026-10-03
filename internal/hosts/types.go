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

type PeerActionResult = LifecycleResponse

type ConnectionState string

const (
	StateConnecting       ConnectionState = "connecting"
	StateOnline           ConnectionState = "online"
	StateUnavailable      ConnectionState = "unavailable"
	StateUnauthorized     ConnectionState = "unauthorized"
	StateIncompatible     ConnectionState = "incompatible"
	StateIdentityMismatch ConnectionState = "identity_mismatch"
)

// HostError deliberately excludes upstream bodies, URLs, and credentials.
type HostError struct {
	Message        string
	State          ConnectionState
	StatusCode     int
	OutcomeUnknown bool
}

func (e *HostError) Error() string { return e.Message }
