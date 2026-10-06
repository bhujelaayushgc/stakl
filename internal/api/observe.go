package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/bhujelaayushgc/stakl/internal/config"
)

type observationSource struct {
	listeningPort
	Path      string `json:"path"`
	Indicator string `json:"indicator"`
}

type observationMetadata struct {
	Cwd     string         `json:"cwd"`
	Docker  *config.Docker `json:"docker,omitempty"`
	Warning string         `json:"warning"`
}

type composeObservation struct {
	Labels map[string]string `json:"labels"`
	Ports  map[string][]struct {
		HostIP   string `json:"HostIp"`
		HostPort string `json:"HostPort"`
	} `json:"ports"`
}

func (s *Server) observe(w http.ResponseWriter, r *http.Request) {
	var source observationSource
	if err := json.NewDecoder(r.Body).Decode(&source); err != nil {
		errorJSON(w, err, 400)
		return
	}
	if (source.Path != "" && source.PID != 0) || (source.Path == "" && (source.PID <= 0 || source.Port < 1 || source.Port > 65535 || source.Protocol != "TCP" || source.Address == "")) {
		errorJSON(w, fmt.Errorf("provide a project directory or a TCP listener"), 400)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	result := observationMetadata{}
	if source.Path == "" {
		// Recheck the listener so a stale scan or reused PID cannot supply unrelated metadata.
		output, err := exec.CommandContext(ctx, "lsof", "-a", "-p", strconv.Itoa(source.PID), "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcgnt").Output()
		found := false
		for _, p := range parseListeningPorts(string(output), "TCP") {
			if p.PID == source.PID && p.Port == source.Port && p.Address == source.Address && (source.Family == "" || p.Family == source.Family) && (source.Process == "" || p.Process == source.Process) && (source.PGID == 0 || p.PGID == source.PGID) {
				found = true
			}
		}
		if err != nil || !found {
			result.Warning = "The listener changed or could not be inspected. Refresh Ports or review the settings manually."
			JSON(w, result)
			return
		}
		result.Cwd = processDirectory(ctx, source.PID)
		if result.Cwd == "" {
			result.Warning = "Could not read the process working directory. Leave it blank for TCP observation or enter it manually."
		}
	}
	projects, err := runningComposeProjects(ctx)
	if err != nil {
		if source.Path != "" {
			result.Warning = "Could not inspect running Compose projects. Check Docker access and enter the existing project name manually."
		} else {
			result.Warning = strings.TrimSpace(result.Warning + " Could not inspect Docker metadata. TCP observation is still available; review Compose settings manually if needed.")
		}
		JSON(w, result)
		return
	}
	var match *composeObservation
	for _, project := range projects {
		if !project.matches(source) {
			continue
		}
		if match != nil && (match.Labels["com.docker.compose.project"] != project.Labels["com.docker.compose.project"] || match.Labels["com.docker.compose.project.working_dir"] != project.Labels["com.docker.compose.project.working_dir"] || match.Labels["com.docker.compose.project.config_files"] != project.Labels["com.docker.compose.project.config_files"]) {
			result.Warning = "Several Compose projects match. Review the directory, Compose file, and existing project name manually."
			JSON(w, result)
			return
		}
		copy := project
		match = &copy
	}
	if match == nil {
		if source.Path != "" {
			result.Warning = "No running Compose project matches this file. Enter the existing project name manually."
		} else if source.Address == "*" && source.Family == "" {
			result.Warning = strings.TrimSpace(result.Warning + " Could not identify the Compose project for this wildcard listener. Review its settings manually.")
		}
	} else {
		cwd := match.Labels["com.docker.compose.project.working_dir"]
		files := strings.Split(match.Labels["com.docker.compose.project.config_files"], ",")
		if len(files) != 1 {
			result.Warning = "This Compose project uses multiple config files. Review its configuration manually; autofill requires a single Compose file."
		} else if !filepath.IsAbs(cwd) || !isDirectory(cwd) {
			result.Warning = "The Compose working directory is not accessible on this host. Review the paths manually."
		} else {
			file := composeFilePath(cwd, strings.TrimSpace(files[0]))
			info, err := os.Stat(file)
			if strings.TrimSpace(files[0]) == "" || err != nil || !info.Mode().IsRegular() {
				result.Warning = "The Compose file is not accessible on this host. Review the paths manually."
			} else {
				result.Cwd = cwd
				result.Docker = &config.Docker{ComposeFile: file, ProjectName: match.Labels["com.docker.compose.project"]}
				result.Warning = ""
			}
		}
	}
	JSON(w, result)
}

func processDirectory(ctx context.Context, pid int) string {
	if path, err := os.Readlink(fmt.Sprintf("/proc/%d/cwd", pid)); err == nil && isDirectory(path) {
		return path
	}
	output, err := exec.CommandContext(ctx, "lsof", "-a", "-p", strconv.Itoa(pid), "-d", "cwd", "-Fn").Output()
	if err == nil {
		for _, line := range strings.Split(string(output), "\n") {
			if strings.HasPrefix(line, "n/") && isDirectory(line[1:]) {
				return line[1:]
			}
		}
	}
	return ""
}

func isDirectory(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func runningComposeProjects(ctx context.Context) ([]composeObservation, error) {
	output, err := exec.CommandContext(ctx, "docker", "ps", "--filter", "label=com.docker.compose.project", "--format", "{{.ID}}").Output()
	if err != nil {
		return nil, err
	}
	ids := strings.Fields(string(output))
	if len(ids) == 0 {
		return nil, nil
	}
	// Inspect only labels and published ports; environment values are never requested.
	args := append([]string{"inspect", "--format", `{"labels":{{json .Config.Labels}},"ports":{{json .NetworkSettings.Ports}}}`}, ids...)
	output, err = exec.CommandContext(ctx, "docker", args...).Output()
	if err != nil {
		return nil, err
	}
	projects := []composeObservation{}
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		if line == "" {
			continue
		}
		var project composeObservation
		if err := json.Unmarshal([]byte(line), &project); err != nil {
			return nil, err
		}
		if project.Labels["com.docker.compose.project"] != "" {
			projects = append(projects, project)
		}
	}
	return projects, nil
}

func composeFilePath(cwd, file string) string {
	if filepath.IsAbs(file) {
		return filepath.Clean(file)
	}
	return filepath.Join(cwd, file)
}

func samePath(a, b string) bool {
	a, errA := filepath.EvalSymlinks(a)
	b, errB := filepath.EvalSymlinks(b)
	return errA == nil && errB == nil && a == b
}

func (p composeObservation) matches(source observationSource) bool {
	if source.Path != "" {
		cwd := p.Labels["com.docker.compose.project.working_dir"]
		if source.Indicator == "" {
			return samePath(source.Path, cwd)
		}
		for _, file := range strings.Split(p.Labels["com.docker.compose.project.config_files"], ",") {
			if samePath(composeFilePath(cwd, strings.TrimSpace(file)), composeFilePath(source.Path, source.Indicator)) {
				return true
			}
		}
		return false
	}
	for containerPort, bindings := range p.Ports {
		if !strings.HasSuffix(containerPort, "/tcp") {
			continue
		}
		for _, binding := range bindings {
			if binding.HostPort != strconv.Itoa(source.Port) {
				continue
			}
			address := strings.Trim(source.Address, "[]")
			if address == "*" {
				ip := net.ParseIP(binding.HostIP)
				if ip != nil && ((source.Family == "IPv4" && ip.To4() != nil) || (source.Family == "IPv6" && ip.To4() == nil)) {
					return true
				}
				continue
			}
			if address == binding.HostIP || binding.HostIP == "" {
				return true
			}
			ip := net.ParseIP(address)
			if ip != nil && ((binding.HostIP == "0.0.0.0" && ip.To4() != nil) || (binding.HostIP == "::" && ip.To4() == nil)) {
				return true
			}
		}
	}
	return false
}
