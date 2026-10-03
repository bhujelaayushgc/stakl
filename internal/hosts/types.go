package hosts

import (
	"time"

	"github.com/bhujelaayushgc/stakl/internal/config"
	"github.com/bhujelaayushgc/stakl/internal/manager"
)

type HostInput struct {
	Name  string `json:"name"`
	URL   string `json:"url"`
	Token string `json:"token"`
	CAPEM string `json:"ca_pem"`
}

type HostPatch struct {
	Name  *string `json:"name,omitempty"`
	URL   *string `json:"url,omitempty"`
	Token *string `json:"token,omitempty"`
	CAPEM *string `json:"ca_pem,omitempty"`
}

// Description and Envelope are safe for API serialization. Credentials and
// custom certificate trust stay in the private storage record.
type Description struct {
	ID           string          `json:"id"`
	ControllerID string          `json:"controller_id"`
	Name         string          `json:"name"`
	URL          string          `json:"url"`
	Access       string          `json:"access"`
	State        ConnectionState `json:"state"`
	LastSeen     time.Time       `json:"last_seen"`
	Stale        bool            `json:"stale"`
	Error        string          `json:"error"`
}

type Envelope struct {
	Host   Description             `json:"host"`
	Groups map[string]config.Group `json:"groups"`
	Apps   []manager.AppView       `json:"apps"`
}

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
