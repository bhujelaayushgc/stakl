package api

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"localdesk/internal/config"
	"localdesk/internal/manager"
	"localdesk/internal/runner"
	"localdesk/internal/supervisor"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Server struct {
	Manager                 *manager.Manager
	Token, Address, Version string
	Started                 time.Time
	Assets                  fs.FS
	BindHost                string
	saveMu                  sync.Mutex
}

func JSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
func errorJSON(w http.ResponseWriter, e error, status int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	JSON(w, map[string]string{"error": e.Error()})
}
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/apps", func(w http.ResponseWriter, r *http.Request) { JSON(w, s.Manager.Views()) })
	mux.HandleFunc("GET /api/apps/{id}", s.app)
	mux.HandleFunc("POST /api/apps/{id}/{action}", s.action)
	mux.HandleFunc("GET /api/apps/{id}/logs", s.logs)
	mux.HandleFunc("GET /api/apps/{id}/health", func(w http.ResponseWriter, r *http.Request) { JSON(w, s.Manager.Store.Checks(r.PathValue("id"))) })
	mux.HandleFunc("GET /api/apps/{id}/history", func(w http.ResponseWriter, r *http.Request) { JSON(w, s.Manager.Store.History(r.PathValue("id"))) })
	mux.HandleFunc("GET /api/apps/{id}/launches", func(w http.ResponseWriter, r *http.Request) { JSON(w, s.Manager.Store.Launches(r.PathValue("id"))) })
	mux.HandleFunc("GET /api/profiles", func(w http.ResponseWriter, r *http.Request) { JSON(w, s.Manager.Config().Profiles) })
	mux.HandleFunc("POST /api/profiles/{id}/{action}", func(w http.ResponseWriter, r *http.Request) {
		action := r.PathValue("action")
		if !validAction(action) {
			errorJSON(w, fmt.Errorf("invalid action"), 400)
			return
		}
		JSON(w, s.Manager.Profile(r.Context(), r.PathValue("id"), action))
	})
	mux.HandleFunc("POST /api/actions/{action}", func(w http.ResponseWriter, r *http.Request) {
		action := r.PathValue("action")
		if !validAction(action) {
			errorJSON(w, fmt.Errorf("invalid action"), 400)
			return
		}
		if action == "stop" && r.URL.Query().Get("confirm") != "true" {
			errorJSON(w, fmt.Errorf("stop all requires confirm=true"), 400)
			return
		}
		JSON(w, s.Manager.Operate(r.Context(), action, s.Manager.GlobalIDs(action == "restart"), false))
	})
	mux.HandleFunc("GET /api/events", s.events)
	mux.HandleFunc("GET /api/config", s.getConfig)
	mux.HandleFunc("POST /api/config/validate", s.validate)
	mux.HandleFunc("POST /api/config/save", s.save)
	mux.HandleFunc("POST /api/config/reload", func(w http.ResponseWriter, r *http.Request) {
		if e := s.Manager.Reload(); e != nil {
			errorJSON(w, e, 400)
			return
		}
		JSON(w, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /api/system/status", s.system)
	mux.HandleFunc("GET /api/system/ports", s.ports)
	mux.HandleFunc("GET /api/history", func(w http.ResponseWriter, r *http.Request) { JSON(w, s.Manager.Store.History("")) })
	mux.HandleFunc("POST /api/discover", s.discover)
	mux.HandleFunc("GET /api/system/docker", func(w http.ResponseWriter, r *http.Request) { JSON(w, runner.DockerAvailable()) })
	mux.HandleFunc("GET /api/system/logs", func(w http.ResponseWriter, r *http.Request) {
		b, _ := os.ReadFile(filepath.Join(s.Manager.Dir, "internal.log"))
		if len(b) > 256*1024 {
			b = b[len(b)-256*1024:]
		}
		JSON(w, map[string]string{"text": string(b)})
	})
	mux.HandleFunc("/", s.frontend)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'self'")
		w.Header().Set("Cache-Control", "no-store")
		if !s.validHost(r.Host) {
			errorJSON(w, fmt.Errorf("unrecognized host"), 403)
			return
		}
		if r.URL.Path == "/" && r.URL.Query().Get("token") != "" {
			if !s.valid(r.URL.Query().Get("token")) {
				http.Error(w, "Invalid dashboard token", http.StatusUnauthorized)
				return
			}
			http.SetCookie(w, &http.Cookie{Name: s.cookieName(), Value: s.Token, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: 365 * 24 * 3600})
			http.Redirect(w, r, "/", http.StatusSeeOther)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			if cookie, e := r.Cookie(s.cookieName()); e == nil && token == "" {
				token = cookie.Value
			}
			if !s.valid(token) {
				errorJSON(w, fmt.Errorf("open LocalDesk from the CLI to authenticate this browser"), 401)
				return
			}
			if origin := r.Header.Get("Origin"); origin != "" && origin != "http://"+r.Host {
				errorJSON(w, fmt.Errorf("cross-origin request refused"), 403)
				return
			}
			if r.Method != "GET" && r.Header.Get("X-LocalDesk") != "1" {
				errorJSON(w, fmt.Errorf("X-LocalDesk header required"), 403)
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, 2*1024*1024)
		}
		mux.ServeHTTP(w, r)
	})
}
func (s *Server) cookieName() string {
	return fmt.Sprintf("localdesk_%x", sha256.Sum256([]byte(s.Address)))[:26]
}
func (s *Server) validHost(address string) bool {
	if address == s.Address {
		return true
	}
	if s.BindHost != "0.0.0.0" && s.BindHost != "::" {
		return false
	}
	host, port, e := net.SplitHostPort(address)
	_, expected, _ := net.SplitHostPort(s.Address)
	ip := net.ParseIP(host)
	return e == nil && port == expected && ip != nil && !ip.IsUnspecified()
}
func (s *Server) valid(v string) bool {
	return subtle.ConstantTimeCompare([]byte(v), []byte(s.Token)) == 1
}
func validAction(a string) bool { return a == "start" || a == "stop" || a == "restart" }
func (s *Server) app(w http.ResponseWriter, r *http.Request) {
	v, ok := s.Manager.View(r.PathValue("id"))
	if !ok {
		errorJSON(w, fmt.Errorf("app not found"), 404)
		return
	}
	JSON(w, v)
}
func (s *Server) action(w http.ResponseWriter, r *http.Request) {
	id, action := r.PathValue("id"), r.PathValue("action")
	v, ok := s.Manager.View(id)
	if !ok {
		errorJSON(w, fmt.Errorf("app not found"), 404)
		return
	}
	if action == "directory" || action == "terminal" {
		if e := OpenLocation(v.Config.Cwd, action == "terminal", s.Manager.Config().Terminal.Command); e != nil {
			errorJSON(w, e, 500)
			return
		}
		JSON(w, map[string]bool{"ok": true})
		return
	}
	if action != "kill" && !validAction(action) {
		errorJSON(w, fmt.Errorf("invalid action"), 400)
		return
	}
	JSON(w, s.Manager.Operate(r.Context(), action, []string{id}, action == "kill"))
}
func (s *Server) getConfig(w http.ResponseWriter, r *http.Request) {
	c := s.Manager.Config()
	response := map[string]any{"path": s.Manager.ConfigPath, "error": s.Manager.Error(), "groups": c.Groups, "profiles": c.Profiles, "logging": c.Logging}
	if r.URL.Query().Get("raw") == "true" {
		b, e := os.ReadFile(s.Manager.ConfigPath)
		if e != nil {
			errorJSON(w, e, 500)
			return
		}
		response["raw"] = string(b)
		response["revision"] = fmt.Sprintf("%x", sha256.Sum256(b))
	}
	JSON(w, response)
}
func readConfig(r *http.Request) ([]byte, error) {
	var b struct {
		YAML string `json:"yaml"`
	}
	if e := json.NewDecoder(r.Body).Decode(&b); e != nil {
		return nil, e
	}
	return []byte(b.YAML), nil
}
func (s *Server) validate(w http.ResponseWriter, r *http.Request) {
	b, e := readConfig(r)
	if e == nil {
		_, e = config.Parse(b, filepath.Dir(s.Manager.ConfigPath))
	}
	if e != nil {
		errorJSON(w, e, 400)
		return
	}
	JSON(w, map[string]bool{"valid": true})
}
func (s *Server) save(w http.ResponseWriter, r *http.Request) {
	s.saveMu.Lock()
	defer s.saveMu.Unlock()
	var edit struct {
		YAML     string `json:"yaml"`
		Revision string `json:"revision"`
	}
	e := json.NewDecoder(r.Body).Decode(&edit)
	b := []byte(edit.YAML)
	if e == nil {
		_, e = config.Parse(b, filepath.Dir(s.Manager.ConfigPath))
	}
	if e != nil {
		errorJSON(w, e, 400)
		return
	}
	old, e := os.ReadFile(s.Manager.ConfigPath)
	if e != nil {
		errorJSON(w, e, 500)
		return
	}
	if edit.Revision == "" || edit.Revision != fmt.Sprintf("%x", sha256.Sum256(old)) {
		errorJSON(w, fmt.Errorf("configuration changed on disk or revision is missing; reload the editor before saving"), http.StatusConflict)
		return
	}
	backup := s.Manager.ConfigPath + ".bak." + time.Now().Format("20060102-150405.000000000")
	if e = os.WriteFile(backup, old, 0600); e == nil {
		e = supervisor.AtomicWrite(s.Manager.ConfigPath, b)
	}
	if e == nil {
		e = s.Manager.Reload()
		if e != nil {
			reloadErr := e
			if restoreErr := supervisor.AtomicWrite(s.Manager.ConfigPath, old); restoreErr != nil {
				e = fmt.Errorf("%v; restoring previous configuration: %w", reloadErr, restoreErr)
			} else if restoreErr = s.Manager.Reload(); restoreErr != nil {
				e = fmt.Errorf("%v; reloading restored configuration: %w", reloadErr, restoreErr)
			} else {
				e = reloadErr
			}
		}
	}
	if e != nil {
		errorJSON(w, e, 400)
		return
	}
	JSON(w, map[string]any{"ok": true, "backup": backup, "revision": fmt.Sprintf("%x", sha256.Sum256(b))})
}
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	f, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unavailable", 500)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	ch, unsub := s.Manager.Bus.Subscribe()
	defer unsub()
	fmt.Fprint(w, "event: ready\ndata: {}\n\n")
	f.Flush()
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case e := <-ch:
			b, _ := json.Marshal(e)
			fmt.Fprintf(w, "data: %s\n\n", b)
			f.Flush()
		case <-ticker.C:
			fmt.Fprint(w, ": heartbeat\n\n")
			f.Flush()
		}
	}
}
func (s *Server) logs(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, ok := s.Manager.View(id); !ok {
		errorJSON(w, fmt.Errorf("app not found"), 404)
		return
	}
	limit := 1000
	if n, e := strconv.Atoi(r.URL.Query().Get("limit")); e == nil && n > 0 && n <= 10000 {
		limit = n
	}
	if r.URL.Query().Get("download") == "true" {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", id+".log"))
		for _, l := range s.Manager.Logs(id, 10000, time.Time{}) {
			fmt.Fprintf(w, "%s [%s] %s\n", l.Time.Format(time.RFC3339Nano), l.Stream, l.Text)
		}
		return
	}
	if r.URL.Query().Get("follow") != "true" {
		JSON(w, s.Manager.Logs(id, limit, time.Time{}))
		return
	}
	f, ok := w.(http.Flusher)
	if !ok {
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	after, _ := time.Parse(time.RFC3339Nano, r.Header.Get("Last-Event-ID"))
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	beat := time.Now()
	for {
		for _, l := range s.Manager.Logs(id, limit, after) {
			b, _ := json.Marshal(l)
			fmt.Fprintf(w, "id: %s\ndata: %s\n\n", l.Time.Format(time.RFC3339Nano), b)
			after = l.Time
		}
		if time.Since(beat) > 15*time.Second {
			fmt.Fprint(w, ": heartbeat\n\n")
			beat = time.Now()
		}
		f.Flush()
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
		}
	}
}
func (s *Server) system(w http.ResponseWriter, r *http.Request) {
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	active := 0
	workers := 0
	for _, v := range s.Manager.Views() {
		if manager.Active(v.Runtime) {
			active++
		}
		if v.Config.Health.Type != "" {
			workers++
		}
	}
	JSON(w, map[string]any{"version": s.Version, "uptime_seconds": time.Since(s.Started).Seconds(), "config_path": s.Manager.ConfigPath, "database_path": filepath.Join(s.Manager.Dir, "state.db"), "log_directory": filepath.Join(s.Manager.Dir, "logs"), "go_version": runtime.Version(), "platform": runtime.GOOS + "/" + runtime.GOARCH, "goroutines": runtime.NumGoroutine(), "memory_bytes": mem.Alloc, "apps": len(s.Manager.Views()), "active_processes": active, "health_workers": 1, "configured_health_checks": workers, "event_subscribers": s.Manager.Bus.Count(), "config_error": s.Manager.Error()})
}
func (s *Server) frontend(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		http.NotFound(w, r)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/")
	if path == "" {
		path = "index.html"
	}
	if _, e := fs.Stat(s.Assets, path); e != nil {
		path = "index.html"
	}
	b, e := fs.ReadFile(s.Assets, path)
	if e != nil {
		http.Error(w, "Frontend not built. Run make frontend and rebuild.", http.StatusServiceUnavailable)
		return
	}
	switch filepath.Ext(path) {
	case ".html":
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
	case ".js":
		w.Header().Set("Content-Type", "text/javascript")
	case ".css":
		w.Header().Set("Content-Type", "text/css")
	case ".svg":
		w.Header().Set("Content-Type", "image/svg+xml")
	}
	w.Write(b)
}

type Suggestion struct {
	Path      string `json:"path"`
	Type      string `json:"type"`
	Command   string `json:"command"`
	Indicator string `json:"indicator"`
	Name      string `json:"name"`
}

func (s *Server) discover(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Path string `json:"path"`
	}
	if e := json.NewDecoder(r.Body).Decode(&in); e != nil {
		errorJSON(w, e, 400)
		return
	}
	root := config.Expand(in.Path, "")
	if in.Path == "" {
		errorJSON(w, fmt.Errorf("choose a directory to scan"), 400)
		return
	}
	if st, e := os.Stat(root); e != nil || !st.IsDir() {
		errorJSON(w, fmt.Errorf("directory does not exist: %s", root), 400)
		return
	}
	out := []Suggestion{}
	seen := map[string]bool{}
	count := 0
	e := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if r.Context().Err() != nil {
			return r.Context().Err()
		}
		count++
		if count > 20000 {
			return filepath.SkipAll
		}
		rel, _ := filepath.Rel(root, path)
		if d.IsDir() {
			if strings.Count(rel, string(filepath.Separator)) > 3 || d.Name() == "node_modules" || d.Name() == ".git" || d.Name() == "vendor" || d.Name() == ".venv" || d.Name() == "target" {
				return filepath.SkipDir
			}
			return nil
		}
		dir := filepath.Dir(path)
		if seen[dir] {
			return nil
		}
		s := Suggestion{Path: dir, Type: "process", Indicator: d.Name(), Name: filepath.Base(dir)}
		switch d.Name() {
		case "compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml":
			s.Type = "docker-compose"
		case "package.json":
			b, e := os.ReadFile(path)
			if e != nil {
				return nil
			}
			var p struct {
				Scripts map[string]string `json:"scripts"`
			}
			if json.Unmarshal(b, &p) != nil {
				return nil
			}
			if p.Scripts["dev"] != "" {
				s.Command = "npm run dev"
			} else if p.Scripts["start"] != "" {
				s.Command = "npm start"
			} else {
				return nil
			}
		case "Gemfile":
			s.Command = "bundle exec rails server"
		case "pyproject.toml":
			s.Command = "uv run python main.py"
		case "go.mod":
			s.Command = "go run ."
		case "Cargo.toml":
			s.Command = "cargo run"
		case "Justfile", "justfile", ".justfile":
			s.Command = "just"
		case "Makefile", "makefile", "GNUmakefile":
			s.Command = "make"
		default:
			return nil
		}
		seen[dir] = true
		out = append(out, s)
		return nil
	})
	if e != nil {
		errorJSON(w, e, 500)
		return
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	JSON(w, map[string]any{"suggestions": out, "truncated": count > 20000})
}
func OpenBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "linux":
		cmd = exec.Command("xdg-open", url)
	default:
		return fmt.Errorf("open %s in your browser", url)
	}
	if e := cmd.Start(); e != nil {
		return e
	}
	go cmd.Wait()
	return nil
}
func OpenLocation(path string, terminal bool, configured string) error {
	if st, e := os.Stat(path); e != nil || !st.IsDir() {
		return fmt.Errorf("directory does not exist")
	}
	var cmd *exec.Cmd
	if terminal {
		if configured != "" {
			switch filepath.Base(configured) {
			case "wezterm":
				cmd = exec.Command(configured, "start", "--cwd", path)
			case "ghostty":
				cmd = exec.Command(configured, "--working-directory="+path)
			default:
				cmd = exec.Command(configured)
				cmd.Dir = path
			}
		} else if runtime.GOOS == "darwin" {
			cmd = exec.Command("open", "-a", "Terminal", path)
		} else {
			cmd = exec.Command("x-terminal-emulator")
			cmd.Dir = path
		}
	} else if runtime.GOOS == "darwin" {
		cmd = exec.Command("open", path)
	} else {
		cmd = exec.Command("xdg-open", path)
	}
	if e := cmd.Start(); e != nil {
		return e
	}
	go cmd.Wait()
	return nil
}
func Notify(title, message string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var cmd *exec.Cmd
	if runtime.GOOS == "darwin" {
		script := `on run argv
 display notification (item 2 of argv) with title (item 1 of argv)
end run`
		cmd = exec.CommandContext(ctx, "osascript", "-e", script, title, message)
	} else {
		cmd = exec.CommandContext(ctx, "notify-send", title, message)
	}
	if e := cmd.Run(); e != nil {
		log.Printf("desktop notification: %v", e)
	}
}
func Client(ctx context.Context, address, token, method, path string, body io.Reader) (*http.Response, error) {
	u, e := url.Parse(address)
	if e != nil {
		return nil, e
	}
	req, e := http.NewRequestWithContext(ctx, method, u.String()+path, body)
	if e != nil {
		return nil, e
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-LocalDesk", "1")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DisableKeepAlives = true
	return (&http.Client{Transport: transport}).Do(req)
}
