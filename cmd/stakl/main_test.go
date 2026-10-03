package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/bhujelaayushgc/stakl/internal/api"
	"github.com/bhujelaayushgc/stakl/internal/config"
	"github.com/bhujelaayushgc/stakl/internal/manager"
	"github.com/bhujelaayushgc/stakl/internal/storage"
)

func captureCLI(fn func() error) (string, error) {
	before := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		return "", err
	}
	os.Stdout = w
	defer func() { os.Stdout = before; r.Close(); w.Close() }()
	result := fn()
	w.Close()
	data, err := io.ReadAll(r)
	if err != nil {
		return "", err
	}
	return string(data), result
}

func TestTLSConfigPairAndReload(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yml")
	original := "version: 1\nserver: {tls_cert_file: cert.pem, tls_key_file: key.pem}\n"
	os.WriteFile(path, []byte(original), 0600)
	c, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	db, err := storage.Open(filepath.Join(dir, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.DB.Close()
	m := manager.New(c, path, dir, db)
	defer m.Close()
	if err := m.Reload(); err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{strings.Replace(original, "cert.pem", "other.pem", 1), strings.Replace(original, "key.pem", "other-key.pem", 1), "version: 1\n"} {
		os.WriteFile(path, []byte(text), 0600)
		if err := m.Reload(); err == nil || !strings.Contains(err.Error(), "restart") {
			t.Fatalf("TLS reload accepted: %v", err)
		}
		if m.Config().Server.TLSCertFile != filepath.Join(dir, "cert.pem") {
			t.Fatal("reload changed active TLS configuration")
		}
	}
}

func TestHTTPSControllerProcess(t *testing.T) {
	path := os.Getenv("STAKL_TEST_HTTPS_CONFIG")
	if path == "" {
		return
	}
	if err := run([]string{"--config", path, "--no-browser"}); err != nil {
		t.Fatal(err)
	}
}

func TestHTTPSInstanceAndCLI(t *testing.T) {
	testInstanceAndCLI(t, true)
}

func TestHTTPInstanceAndCLI(t *testing.T) {
	testInstanceAndCLI(t, false)
}

func testInstanceAndCLI(t *testing.T, useTLS bool) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yml")
	if useTLS {
		if _, err := captureCLI(func() error { return run([]string{"--config", path, "tls", "init", "--host", "peer.example"}) }); err != nil {
			t.Fatal(err)
		}
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	text := fmt.Sprintf("version: 1\nserver: {port: %d, tls_cert_file: tls-cert.pem, tls_key_file: tls-key.pem}\n", port)
	if !useTLS {
		text = fmt.Sprintf("version: 1\nserver: {port: %d}\n", port)
	}
	if err := os.WriteFile(path, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestHTTPSControllerProcess$")
	cmd.Env = append(os.Environ(), "STAKL_TEST_HTTPS_CONFIG="+path)
	logFile, err := os.Create(filepath.Join(dir, "process.log"))
	if err != nil {
		t.Fatal(err)
	}
	defer logFile.Close()
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		cmd.Process.Signal(os.Interrupt)
		if err := cmd.Wait(); err != nil {
			data, _ := os.ReadFile(logFile.Name())
			t.Errorf("controller shutdown: %v\n%s", err, data)
		}
	}()
	var inst instance
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var alive bool
		inst, alive = existing(dir)
		if alive {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	wantScheme, wantCA := "http://", ""
	if useTLS {
		wantScheme, wantCA = "https://", filepath.Join(dir, "tls-cert.pem")
	}
	if !strings.HasPrefix(inst.URL, wantScheme) || inst.CAFile != wantCA {
		data, _ := os.ReadFile(logFile.Name())
		t.Fatalf("HTTPS metadata: %+v\n%s", inst, data)
	}
	if _, alive := existing(dir); !alive {
		t.Fatal("trusted HTTPS instance was not detected")
	}
	output, err := captureCLI(func() error { return cli(inst, []string{"status"}) })
	if err != nil || !strings.Contains(output, "STATE") {
		t.Fatalf("HTTPS status: %s %v", output, err)
	}
	if useTLS {
		savedCA := inst.CAFile
		inst.CAFile = filepath.Join(dir, "missing.pem")
		if err := cli(inst, []string{"status"}); err == nil {
			t.Fatal("missing CA accepted")
		}
		inst.CAFile = savedCA
	}
	output, err = captureCLI(func() error {
		return runPeerTokens(inst, []string{"create", "--name", "Laptop", "--access", "control"})
	})
	if err != nil {
		t.Fatal(err)
	}
	var grant struct{ ID, Token string }
	if err := json.Unmarshal([]byte(output), &grant); err != nil || grant.Token == "" {
		t.Fatalf("create: %s %v", output, err)
	}
	ca, _ := os.ReadFile(inst.CAFile)
	response, err := api.ClientWithCA(context.Background(), inst.URL, grant.Token, "GET", "/api/peer/v1/info", nil, ca)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal(response.Status)
	}
	testPeerTokenCLI(t, inst, grant.ID, grant.Token)
}

func TestPeerTokenCLI(t *testing.T) {
	for _, args := range [][]string{{}, {"create"}, {"create", "--name", "x", "--access", "admin"}, {"create", "--name", "x", "--unknown"}, {"list", "extra"}, {"revoke", "../bad"}} {
		if err := runPeerTokens(instance{}, args); err == nil {
			t.Fatalf("accepted invalid args: %v", args)
		}
	}
	dir := t.TempDir()
	c, err := config.Parse([]byte("version: 1\n"), dir)
	if err != nil {
		t.Fatal(err)
	}
	db, err := storage.Open(filepath.Join(dir, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.DB.Close()
	m := manager.New(c, filepath.Join(dir, "config.yml"), dir, db)
	defer m.Close()
	server := httptest.NewUnstartedServer(nil)
	s := &api.Server{Manager: m, Address: server.Listener.Addr().String(), Token: "admin"}
	server.Config.Handler = s.Handler()
	server.Start()
	defer server.Close()
	defer s.CancelPeerStreams()
	inst := instance{URL: server.URL, Token: "admin"}
	output, err := captureCLI(func() error {
		return runPeerTokens(inst, []string{"create", "--name", "Laptop", "--access", "control"})
	})
	if err != nil {
		t.Fatal(err)
	}
	var grant struct{ ID, Token string }
	if err := json.Unmarshal([]byte(output), &grant); err != nil || grant.ID == "" || grant.Token == "" {
		t.Fatalf("create output: %s %v", output, err)
	}
	testPeerTokenCLI(t, inst, grant.ID, grant.Token)
}

func testPeerTokenCLI(t *testing.T, inst instance, id, token string) {
	t.Helper()
	output, err := captureCLI(func() error { return cli(inst, []string{"peer", "tokens", "list"}) })
	if err != nil || !strings.Contains(output, id) || strings.Contains(output, token) {
		t.Fatalf("list leaked token or missed metadata: %s %v", output, err)
	}
	output, err = captureCLI(func() error { return cli(inst, []string{"peer", "tokens", "revoke", id}) })
	if err != nil {
		t.Fatalf("revoke: %s %v", output, err)
	}
	output, err = captureCLI(func() error { return runPeerTokens(inst, []string{"list"}) })
	if err != nil || strings.Contains(output, id) {
		t.Fatalf("revoked grant still listed: %s %v", output, err)
	}
	output, err = captureCLI(func() error { return runPeerTokens(inst, []string{"create", "--name", "Read only"}) })
	if err != nil || !strings.Contains(output, `"access": "read"`) {
		t.Fatalf("default access: %s %v", output, err)
	}
}

func TestFailedBackupRemovesPartialArchive(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.yml")
	if e := os.WriteFile(configPath, []byte("version: 1\n"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(dir, "state.db"), []byte("not sqlite"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := backup(configPath, dir); e == nil {
		t.Fatal("invalid database produced a backup")
	}
	archives, e := filepath.Glob(filepath.Join(dir, "backup-*.zip"))
	if e != nil {
		t.Fatal(e)
	}
	if len(archives) != 0 {
		t.Fatalf("failed backup left partial archives: %v", archives)
	}
}
