package supervisor

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/bhujelaayushgc/stakl/internal/config"
	"github.com/mattn/go-shellwords"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Spec struct {
	BootID  string         `json:"boot_id"`
	Purpose string         `json:"purpose"`
	ID      string         `json:"id"`
	Token   string         `json:"token"`
	App     config.App     `json:"app"`
	Command config.Command `json:"command"`
	Env     []string       `json:"env"`
	LogPath string         `json:"log_path"`
	Logging config.Logging `json:"logging"`
	Socket  string         `json:"socket"`
}
type State struct {
	Rebooted bool       `json:"rebooted,omitempty"`
	ID       string     `json:"id"`
	PID      int        `json:"pid"`
	PGID     int        `json:"pgid"`
	Running  bool       `json:"running"`
	Started  time.Time  `json:"started"`
	Exited   *time.Time `json:"exited,omitempty"`
	ExitCode *int       `json:"exit_code,omitempty"`
	Error    string     `json:"error,omitempty"`
	Stopped  bool       `json:"stopped"`
}

func Token() string {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
func AtomicJSON(path string, v any) error {
	b, e := json.MarshalIndent(v, "", "  ")
	if e != nil {
		return e
	}
	return AtomicWrite(path, b)
}
func AtomicWrite(path string, b []byte) error {
	f, e := os.CreateTemp(filepath.Dir(path), ".stakl-*")
	if e != nil {
		return e
	}
	name := f.Name()
	defer os.Remove(name)
	if e = f.Chmod(0600); e == nil {
		_, e = f.Write(b)
	}
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	return os.Rename(name, path)
}
func Command(c config.Command, a config.App, env []string) (*exec.Cmd, error) {
	var args []string
	var e error
	if c.Shell {
		sh := os.Getenv("SHELL")
		if sh == "" {
			sh = "/bin/sh"
		}
		args = []string{sh, "-c", c.Command}
	} else {
		args, e = shellwords.Parse(c.Command)
		if e != nil {
			return nil, e
		}
		args = append(args, c.Args...)
	}
	if len(args) == 0 {
		return nil, fmt.Errorf("command is empty")
	}
	executable := args[0]
	if !strings.ContainsRune(executable, filepath.Separator) {
		path := "/usr/bin:/bin"
		for _, item := range env {
			if strings.HasPrefix(item, "PATH=") {
				path = strings.TrimPrefix(item, "PATH=")
				break
			}
		}
		found := ""
		for _, dir := range filepath.SplitList(path) {
			if !filepath.IsAbs(dir) {
				dir = filepath.Join(a.Cwd, dir)
			}
			candidate := filepath.Join(dir, executable)
			if st, err := os.Stat(candidate); err == nil && !st.IsDir() && st.Mode()&0111 != 0 {
				found = candidate
				break
			}
		}
		if found == "" {
			return nil, fmt.Errorf("executable %q not found in application PATH", executable)
		}
		executable = found
	}
	cmd := exec.Command(executable, args[1:]...)
	cmd.Dir = a.Cwd
	cmd.Env = env
	return cmd, nil
}
func Launch(dir string, a config.App, c config.Command, env []string, logging config.Logging, purpose ...string) (Spec, State, error) {
	boot, e := BootID()
	if e != nil || boot == "" {
		return Spec{}, State{}, fmt.Errorf("cannot identify machine boot session: %v", e)
	}
	id := Token()[:24]
	socketDir := filepath.Join(os.TempDir(), fmt.Sprintf("stakl-%d", os.Getuid()))
	if e := os.MkdirAll(socketDir, 0700); e != nil {
		return Spec{}, State{}, e
	}
	if st, e := os.Lstat(socketDir); e != nil || !st.IsDir() || st.Mode().Perm() != 0700 {
		return Spec{}, State{}, fmt.Errorf("unsafe supervisor socket directory %s", socketDir)
	}
	s := Spec{BootID: boot, ID: id, Token: Token(), App: a, Command: c, Env: env, Logging: logging, Socket: filepath.Join(socketDir, id+".sock"), LogPath: filepath.Join(dir, "logs", a.ID+"-"+id+".jsonl")}
	path := ""
	persistFailure := false
	fail := func(err error) (Spec, State, error) {
		now := time.Now().UTC()
		code := -1
		st := State{ID: id, Started: now, Exited: &now, ExitCode: &code, Error: err.Error()}
		if persistFailure {
			if persistErr := AtomicJSON(path+".exit", st); persistErr != nil {
				return s, st, fmt.Errorf("%w; persist launch failure: %v", err, persistErr)
			}
		}
		return s, st, err
	}
	s.Purpose = "workload"
	if len(purpose) > 0 {
		s.Purpose = purpose[0]
	}
	launchDir := filepath.Join(dir, "launches")
	for _, p := range []string{launchDir, filepath.Join(dir, "logs")} {
		if e := os.MkdirAll(p, 0700); e != nil {
			return fail(e)
		}
	}
	path = filepath.Join(launchDir, id+".json")
	if e := AtomicJSON(path, s); e != nil {
		return fail(e)
	}
	persistFailure = true
	exe, e := os.Executable()
	if e != nil {
		return fail(e)
	}
	cmd := exec.Command(exe, "__supervise", path)
	Detach(cmd)
	null, e := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if e != nil {
		return fail(e)
	}
	defer null.Close()
	cmd.Stdin = null
	cmd.Stdout = null
	cmd.Stderr = null
	if e = cmd.Start(); e != nil {
		return fail(e)
	}
	go cmd.Wait()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		st, e := Query(s, "status", nil)
		if e == nil {
			return s, st, nil
		}
		if b, e := os.ReadFile(path + ".exit"); e == nil {
			var st State
			if e = json.Unmarshal(b, &st); e != nil {
				return s, st, fmt.Errorf("invalid supervisor exit record: %w", e)
			}
			if st.ID != s.ID {
				return s, st, fmt.Errorf("supervisor exit identity mismatch")
			}
			if st.Error == "" {
				st.Error = "workload exited before supervisor became ready"
			}
			return s, st, errors.New(st.Error)
		}
		time.Sleep(25 * time.Millisecond)
	}
	return s, State{}, fmt.Errorf("supervisor did not become ready; launch %s retained for recovery", id)
}
func LoadSpec(dir, id string) (Spec, error) {
	var s Spec
	if !config.ValidID(id) {
		return s, fmt.Errorf("invalid launch ID")
	}
	b, e := os.ReadFile(filepath.Join(dir, "launches", id+".json"))
	if e == nil {
		e = json.Unmarshal(b, &s)
	}
	return s, e
}
func Query(s Spec, action string, body any) (State, error) {
	var st State
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", s.Socket)
	}}
	defer transport.CloseIdleConnections()
	timeout := 3 * time.Second
	if action == "stop" {
		timeout = s.App.Stop.Timeout.Value() + 5*time.Second
	}
	client := http.Client{Transport: transport, Timeout: timeout}
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", "http://supervisor/"+action, strings.NewReader(string(b)))
	req.Header.Set("Authorization", "Bearer "+s.Token)
	r, e := client.Do(req)
	if e != nil {
		return st, e
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return st, fmt.Errorf("supervisor: HTTP %d", r.StatusCode)
	}
	e = json.NewDecoder(r.Body).Decode(&st)
	if e == nil && st.ID != s.ID {
		return st, fmt.Errorf("supervisor identity mismatch")
	}
	return st, e
}
func Inspect(dir, id string) (Spec, State, bool, error) {
	s, e := LoadSpec(dir, id)
	if e != nil {
		return s, State{}, false, e
	}
	st, e := Query(s, "status", nil)
	if e == nil {
		return s, st, true, nil
	}
	b, readErr := os.ReadFile(filepath.Join(dir, "launches", id+".json.exit"))
	if readErr == nil {
		var done State
		if json.Unmarshal(b, &done) == nil && done.ID == id {
			return s, done, true, nil
		}
	}
	if s.BootID != "" {
		if current, bootErr := BootID(); bootErr == nil && current != "" && current != s.BootID {
			now := time.Now().UTC()
			code := 0
			ended := State{ID: id, Exited: &now, ExitCode: &code, Stopped: true, Rebooted: true, Error: "Previous machine boot ended"}
			if err := AtomicJSON(filepath.Join(dir, "launches", id+".json.exit"), ended); err != nil {
				return s, st, false, fmt.Errorf("persist reboot reconciliation: %w", err)
			}
			return s, ended, true, nil
		}
	}
	return s, st, false, e
}
func Run(path string) error {
	b, e := os.ReadFile(path)
	if e != nil {
		return e
	}
	var s Spec
	if e = json.Unmarshal(b, &s); e != nil {
		return e
	}
	state := State{ID: s.ID, Started: time.Now().UTC()}
	var mu sync.Mutex
	var stopMu sync.Mutex
	var once sync.Once
	done := make(chan struct{})
	finish := func(err error) {
		mu.Lock()
		state.Running = false
		t := time.Now().UTC()
		state.Exited = &t
		code := 0
		if err != nil {
			code = -1
			var ee *exec.ExitError
			if errors.As(err, &ee) {
				code = ee.ExitCode()
			}
			state.Error = err.Error()
		}
		state.ExitCode = &code
		AtomicJSON(path+".exit", state)
		mu.Unlock()
		once.Do(func() { close(done) })
	}
	cmd, e := Command(s.Command, s.App, s.Env)
	if e != nil {
		finish(e)
		return e
	}
	Group(cmd)
	lw := &logWriter{path: s.LogPath, app: s.App.ID, launch: s.ID, policy: s.Logging}
	out := &streamWriter{w: lw, stream: "stdout"}
	errout := &streamWriter{w: lw, stream: "stderr"}
	cmd.Stdout = out
	cmd.Stderr = errout
	cmd.WaitDelay = 2 * time.Second
	listener, e := net.Listen("unix", s.Socket)
	if e != nil {
		finish(e)
		return e
	}
	defer os.Remove(s.Socket)
	defer listener.Close()
	if e = os.Chmod(s.Socket, 0600); e != nil {
		finish(e)
		return e
	}
	if e = cmd.Start(); e != nil {
		lw.write("stderr", e.Error())
		finish(e)
		return e
	}
	state.PID = cmd.Process.Pid
	state.PGID = cmd.Process.Pid
	state.Running = true
	pid := cmd.Process.Pid
	stop := func(signal string) {
		stopMu.Lock()
		mu.Lock()
		running := state.Running
		if running {
			state.Stopped = true
		}
		mu.Unlock()
		if running {
			_ = SignalGroup(pid, signal)
		}
		stopMu.Unlock()
		if !running {
			return
		}
		select {
		case <-done:
			return
		case <-time.After(s.App.Stop.Timeout.Value()):
			stopMu.Lock()
			mu.Lock()
			running = state.Running
			mu.Unlock()
			if running {
				_ = SignalGroup(pid, "KILL")
			}
			stopMu.Unlock()
			select {
			case <-done:
			case <-time.After(3 * time.Second):
			}
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+s.Token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if r.URL.Path == "/stop" {
			var v struct {
				Force bool `json:"force"`
			}
			json.NewDecoder(r.Body).Decode(&v)
			sig := strings.TrimPrefix(s.App.Stop.Signal, "SIG")
			if v.Force {
				sig = "KILL"
			}
			stop(sig)
		} else if r.URL.Path != "/status" {
			http.NotFound(w, r)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(state)
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 3 * time.Second}
	go server.Serve(listener)
	// Keep the leader unreaped until its entire group is terminated. Never signal a cached PID.
	observeErr := WaitExited(pid)
	stopMu.Lock()
	if observeErr == nil {
		_ = SignalGroup(pid, "KILL")
	}
	waitErr := cmd.Wait()
	out.flush()
	errout.flush()
	finish(waitErr)
	stopMu.Unlock()
	time.Sleep(300 * time.Millisecond)
	server.Close()
	return nil
}
