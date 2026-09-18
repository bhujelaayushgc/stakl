package api

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"time"
)

type listeningPort struct {
	Port     int    `json:"port"`
	Protocol string `json:"protocol"`
	Address  string `json:"address"`
	PID      int    `json:"pid"`
	PGID     int    `json:"pgid"`
	Process  string `json:"process"`
}

func (s *Server) ports(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	ports := []listeningPort{}
	warnings := []string{}
	for _, protocol := range []string{"TCP", "UDP"} {
		args := []string{"-nP", "-i" + protocol, "-Fpcgn"}
		if protocol == "TCP" {
			args = append(args, "-sTCP:LISTEN")
		}
		cmd := exec.CommandContext(ctx, "lsof", args...)
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		output, err := cmd.Output()
		var exit *exec.ExitError
		// lsof exits 1 when no matching sockets exist.
		empty := errors.As(err, &exit) && exit.ExitCode() == 1 && len(output) == 0 && stderr.Len() == 0
		if err != nil && !empty {
			errorJSON(w, fmt.Errorf("cannot inspect %s ports: ensure lsof is installed and permitted to inspect processes (%v)", protocol, err), http.StatusServiceUnavailable)
			return
		}
		ports = append(ports, parseListeningPorts(string(output), protocol)...)
		if stderr.Len() > 0 {
			warnings = append(warnings, strings.TrimSpace(stderr.String()))
		}
	}
	sort.Slice(ports, func(i, j int) bool {
		a, b := ports[i], ports[j]
		if a.Port != b.Port {
			return a.Port < b.Port
		}
		if a.Protocol != b.Protocol {
			return a.Protocol < b.Protocol
		}
		if a.PID != b.PID {
			return a.PID < b.PID
		}
		return a.Address < b.Address
	})
	JSON(w, map[string]any{"ports": ports, "scanned_at": time.Now(), "warning": strings.Join(warnings, "\n")})
}

func parseListeningPorts(output, protocol string) []listeningPort {
	ports := []listeningPort{}
	seen := map[listeningPort]bool{}
	var process listeningPort
	for _, line := range strings.Split(output, "\n") {
		if len(line) < 2 {
			continue
		}
		value := line[1:]
		switch line[0] {
		case 'p':
			process = listeningPort{Protocol: protocol}
			process.PID, _ = strconv.Atoi(value)
		case 'g':
			process.PGID, _ = strconv.Atoi(value)
		case 'c':
			process.Process = value
		case 'n':
			// Connected UDP sockets also reserve their local endpoint.
			local, _, _ := strings.Cut(value, "->")
			colon := strings.LastIndexByte(local, ':')
			if colon < 0 || process.PID <= 0 {
				continue
			}
			port, err := strconv.Atoi(local[colon+1:])
			if err != nil || port < 1 || port > 65535 {
				continue
			}
			entry := process
			entry.Port, entry.Address = port, local[:colon]
			if !seen[entry] {
				ports = append(ports, entry)
				seen[entry] = true
			}
		}
	}
	return ports
}
