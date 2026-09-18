package main

import (
	"archive/zip"
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"localdesk/internal/api"
	"localdesk/internal/config"
	"localdesk/internal/manager"
	"localdesk/internal/storage"
	"localdesk/internal/supervisor"
	"localdesk/web"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var version = "dev"

type instance struct {
	URL   string `json:"url"`
	Token string `json:"token"`
	PID   int    `json:"pid"`
}

func main() {
	if len(os.Args) > 2 && os.Args[1] == "__supervise" {
		if e := supervisor.Run(os.Args[2]); e != nil {
			os.Exit(1)
		}
		return
	}
	if e := run(os.Args[1:]); e != nil {
		fmt.Fprintln(os.Stderr, "LocalDesk:", e)
		os.Exit(1)
	}
}
func run(args []string) error {
	path := config.Path()
	noBrowser := false
	port := 0
	filtered := []string{}
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--config", "--port":
			if i+1 >= len(args) {
				return fmt.Errorf("%s needs a value", args[i])
			}
			if args[i] == "--config" {
				path = args[i+1]
			} else {
				var e error
				port, e = strconv.Atoi(args[i+1])
				if e != nil || port < 1 || port > 65535 {
					return fmt.Errorf("invalid port")
				}
			}
			i++
		case "--no-browser":
			noBrowser = true
		case "--version":
			fmt.Println(version)
			return nil
		case "--help", "help", "-h":
			fmt.Println(`LocalDesk - local application control plane
Usage: localdesk [--config PATH] [--port PORT] [--no-browser]
  status | list                    List apps and runtime state
  start|stop|restart APP            Operate on an app
  start|stop --all [--yes]          Operate on included apps
  logs APP [--follow]              Read captured logs
  profile start|stop|restart ID     Operate on a profile
  config validate|path|reload       Manage YAML configuration
  init | open | backup             Setup, dashboard, backup
  reset-state --yes                Reset runtime metadata (server must be stopped)
  version                         Print version`)
			return nil
		default:
			filtered = append(filtered, args[i])
		}
	}
	args = filtered
	path = config.Expand(path, "")
	dir := filepath.Dir(path)
	if len(args) > 0 && args[0] == "version" {
		fmt.Println(version)
		return nil
	}
	if len(args) > 1 && args[0] == "config" && args[1] == "path" {
		fmt.Println(path)
		return nil
	}
	if len(args) > 0 && args[0] == "init" {
		if e := config.Init(path); e != nil {
			return e
		}
		fmt.Println(path)
		return nil
	}
	if len(args) > 1 && args[0] == "config" && args[1] == "validate" {
		_, e := config.Load(path)
		if e == nil {
			fmt.Println("Configuration valid:", path)
		}
		return e
	}
	if len(args) > 0 && args[0] == "backup" {
		return backup(path, dir)
	}
	if len(args) > 0 && args[0] == "reset-state" {
		return reset(dir, args)
	}
	if e := config.Init(path); e != nil {
		return e
	}
	inst, alive := existing(dir)
	if len(args) > 0 && args[0] == "open" {
		if !alive {
			return fmt.Errorf("LocalDesk is not running; run localdesk first")
		}
		return api.OpenBrowser(inst.URL + "/?token=" + inst.Token)
	}
	if len(args) > 0 {
		if !alive {
			return fmt.Errorf("LocalDesk is not running for %s; start localdesk first", path)
		}
		return cli(inst, args)
	}
	if alive {
		fmt.Println(inst.URL)
		if !noBrowser {
			return api.OpenBrowser(inst.URL + "/?token=" + inst.Token)
		}
		return nil
	}
	c, e := config.Load(path)
	if e != nil {
		return e
	}
	listenPort := c.Server.Port
	if port != 0 {
		listenPort = port
	}
	lock, e := supervisor.Lock(filepath.Join(dir, "instance.lock"))
	if e != nil {
		return e
	}
	defer lock.Close()
	db, e := storage.Open(filepath.Join(dir, "state.db"))
	if e != nil {
		return e
	}
	defer db.DB.Close()
	os.Chmod(filepath.Join(dir, "state.db"), 0600)
	logPath := filepath.Join(dir, "internal.log")
	if st, e := os.Stat(logPath); e == nil && st.Size() > 5*1024*1024 {
		os.Rename(logPath, logPath+".1")
	}
	lf, e := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	defer lf.Close()
	log.SetOutput(io.MultiWriter(os.Stderr, lf))
	address := net.JoinHostPort(c.Server.Host, strconv.Itoa(listenPort))
	listener, e := net.Listen("tcp", address)
	if e != nil {
		return fmt.Errorf("cannot bind %s: %w; use --port to select another port", address, e)
	}
	defer listener.Close()
	token := c.Server.Token
	if token == "" {
		token = supervisor.Token()
	}
	host := c.Server.Host
	if host == "0.0.0.0" {
		host = "127.0.0.1"
	}
	if host == "::" {
		host = "::1"
	}
	clientAddress := net.JoinHostPort(host, strconv.Itoa(listenPort))
	inst = instance{URL: "http://" + clientAddress, Token: token, PID: os.Getpid()}
	if e = supervisor.AtomicJSON(filepath.Join(dir, "instance.json"), inst); e != nil {
		return e
	}
	defer os.Remove(filepath.Join(dir, "instance.json"))
	m := manager.New(c, path, dir, db)
	m.Notify = api.Notify
	s := &api.Server{Manager: m, Token: token, Address: clientAddress, BindHost: c.Server.Host, Version: version, Started: time.Now(), Assets: web.Assets()}
	server := &http.Server{Handler: s.Handler(), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second}
	go func() {
		if e := server.Serve(listener); e != nil && !errors.Is(e, http.ErrServerClosed) {
			log.Printf("HTTP server: %v", e)
		}
	}()
	m.StartWorkers()
	watchCtx, watchCancel := context.WithCancel(context.Background())
	defer watchCancel()
	go watch(watchCtx, m, path)
	fmt.Printf("LocalDesk %s\n%s\nConfiguration: %s\n", version, inst.URL, path)
	if !noBrowser && (c.Server.OpenBrowser == nil || *c.Server.OpenBrowser) {
		if e = api.OpenBrowser(inst.URL + "/?token=" + token); e != nil {
			log.Printf("browser: %v", e)
		}
	}
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	signal.Stop(sig)
	watchCancel()
	_ = server.Close()
	m.Close()
	return nil
}
func existing(dir string) (instance, bool) {
	var i instance
	b, e := os.ReadFile(filepath.Join(dir, "instance.json"))
	if e != nil || json.Unmarshal(b, &i) != nil {
		return i, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	r, e := api.Client(ctx, i.URL, i.Token, "GET", "/api/system/status", nil)
	if e != nil {
		return i, false
	}
	defer r.Body.Close()
	return i, r.StatusCode == 200
}
func cli(i instance, args []string) error {
	method := "GET"
	path := ""
	switch args[0] {
	case "status", "list":
		path = "/api/apps"
	case "start", "stop", "restart":
		method = "POST"
		if len(args) < 2 {
			return fmt.Errorf("app ID or --all required")
		}
		if args[1] == "--all" {
			path = "/api/actions/" + args[0]
			if args[0] == "stop" {
				if !contains(args, "--yes") {
					fmt.Print("Stop all included apps? [y/N] ")
					var answer string
					fmt.Scanln(&answer)
					if strings.ToLower(answer) != "y" {
						return fmt.Errorf("cancelled")
					}
				}
				path += "?confirm=true"
			}
		} else {
			if !config.ValidID(args[1]) {
				return fmt.Errorf("invalid app ID")
			}
			path = "/api/apps/" + args[1] + "/" + args[0]
		}
	case "profile":
		if len(args) != 3 || !config.ValidID(args[2]) {
			return fmt.Errorf("usage: localdesk profile start|stop|restart ID")
		}
		method = "POST"
		path = "/api/profiles/" + args[2] + "/" + args[1]
	case "config":
		if len(args) != 2 || args[1] != "reload" {
			return fmt.Errorf("usage: localdesk config validate|path|reload")
		}
		method = "POST"
		path = "/api/config/reload"
	case "logs":
		if len(args) < 2 || !config.ValidID(args[1]) {
			return fmt.Errorf("app ID required")
		}
		path = "/api/apps/" + args[1] + "/logs?download=true"
		if contains(args, "--follow") {
			path = "/api/apps/" + args[1] + "/logs?follow=true"
		}
	default:
		return fmt.Errorf("unknown command %q; run localdesk --help", args[0])
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	r, e := api.Client(ctx, i.URL, i.Token, method, path, nil)
	if e != nil {
		return e
	}
	defer r.Body.Close()
	if r.StatusCode >= 400 {
		b, _ := io.ReadAll(r.Body)
		return fmt.Errorf("%s", strings.TrimSpace(string(b)))
	}
	if args[0] == "logs" {
		if contains(args, "--follow") {
			sc := bufio.NewScanner(r.Body)
			sc.Buffer(make([]byte, 65536), 1024*1024)
			for sc.Scan() {
				if strings.HasPrefix(sc.Text(), "data: ") {
					var l supervisor.Log
					if json.Unmarshal([]byte(strings.TrimPrefix(sc.Text(), "data: ")), &l) == nil {
						fmt.Printf("%s [%s] %s\n", l.Time.Format("15:04:05"), l.Stream, l.Text)
					}
				}
			}
			if ctx.Err() != nil {
				return nil
			}
			return sc.Err()
		}
		_, e = io.Copy(os.Stdout, r.Body)
		return e
	}
	if args[0] == "status" || args[0] == "list" {
		var apps []manager.AppView
		if e = json.NewDecoder(r.Body).Decode(&apps); e != nil {
			return e
		}
		fmt.Printf("%-24s %-12s %-8s %s\n", "APP", "STATE", "PID", "NAME")
		for _, a := range apps {
			fmt.Printf("%-24s %-12s %-8d %s\n", a.Config.ID, a.Runtime.State, a.Runtime.PID, a.Config.Name)
		}
		return nil
	}
	var result map[string]any
	if e = json.NewDecoder(r.Body).Decode(&result); e != nil {
		return e
	}
	b, _ := json.MarshalIndent(result, "", "  ")
	fmt.Println(string(b))
	for _, v := range result {
		if message, ok := v.(string); ok && message != "ok" {
			return fmt.Errorf("one or more operations failed")
		}
	}
	return nil
}
func contains(a []string, s string) bool {
	for _, v := range a {
		if v == s {
			return true
		}
	}
	return false
}
func watch(ctx context.Context, m *manager.Manager, path string) {
	b, _ := os.ReadFile(path)
	last := sha256.Sum256(b)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			b, e := os.ReadFile(path)
			if e != nil {
				continue
			}
			sum := sha256.Sum256(b)
			if sum != last {
				last = sum
				if e = m.Reload(); e != nil {
					log.Printf("config reload: %v", e)
				}
			}
		}
	}
}
func backup(path, dir string) error {
	if _, e := os.Stat(path); e != nil {
		return e
	}
	target := filepath.Join(dir, "backup-"+time.Now().Format("20060102-150405")+".zip")
	f, e := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	defer f.Close()
	z := zip.NewWriter(f)
	add := func(name, p string) error {
		b, e := os.ReadFile(p)
		if e != nil {
			return e
		}
		w, e := z.Create(name)
		if e != nil {
			return e
		}
		_, e = w.Write(b)
		return e
	}
	if e = add("config.yml", path); e != nil {
		return e
	}
	dbPath := filepath.Join(dir, "state.db")
	if _, err := os.Stat(dbPath); err == nil {
		db, e := storage.Open(dbPath)
		if e != nil {
			return e
		}
		tmp := filepath.Join(dir, "backup-state-"+supervisor.Token()[:12]+".db")
		defer os.Remove(tmp)
		_, e = db.DB.Exec("VACUUM INTO ?", tmp)
		db.DB.Close()
		if e != nil {
			return e
		}
		if e = add("state.db", tmp); e != nil {
			return e
		}
	}
	if e = z.Close(); e != nil {
		return e
	}
	fmt.Println(target)
	return nil
}
func reset(dir string, args []string) error {
	if !contains(args, "--yes") {
		return fmt.Errorf("reset-state requires --yes; it clears runtime metadata, never project files")
	}
	lock, e := supervisor.Lock(filepath.Join(dir, "instance.lock"))
	if e != nil {
		return e
	}
	defer lock.Close()
	paths, _ := filepath.Glob(filepath.Join(dir, "launches", "*.json"))
	for _, p := range paths {
		var s supervisor.Spec
		b, _ := os.ReadFile(p)
		if json.Unmarshal(b, &s) == nil {
			_, st, verified, _ := supervisor.Inspect(dir, s.ID)
			if verified && st.Running {
				return fmt.Errorf("cannot reset while launch %s is running; stop managed apps first", s.ID)
			}
			if !verified {
				return fmt.Errorf("cannot reset unverified launch %s; inspect it first", s.ID)
			}
		}
	}
	for _, name := range []string{"state.db", "state.db-wal", "state.db-shm", "instance.json"} {
		if e := os.Remove(filepath.Join(dir, name)); e != nil && !os.IsNotExist(e) {
			return e
		}
	}
	fmt.Println("Runtime state reset. Configuration, logs, and project directories preserved.")
	return nil
}
