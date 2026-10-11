package api

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/bhujelaayushgc/stakl/internal/peeraccess"
)

func scopedRequest(h http.Handler, method, path, token, identity string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "https://192.0.2.1:49153"+path, nil)
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("X-Stakl", "1")
	r.Header.Set("X-Stakl-Peer-ID", identity)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestPeerOnlyHandlerSecurityBoundary(t *testing.T) {
	s, primary := peerFixture(t)
	_, read := issuePeer(t, primary, "read")
	_, control := issuePeer(t, primary, "control")
	h := s.PeerHandler("192.0.2.1:49153")
	for _, path := range []string{"/", "/api/peer-tokens", "/api/peer-access", "/api/config", "/api/hosts", "/api/peer/v1/../peer-tokens"} {
		if w := scopedRequest(h, "GET", path, control, ""); w.Code == 200 {
			t.Fatalf("exposed %s", path)
		}
	}
	if w := scopedRequest(h, "GET", "/api/peer/v1/info", "admin", ""); w.Code != 401 {
		t.Fatalf("admin authorized as peer: %d", w.Code)
	}
	if w := scopedRequest(h, "GET", "/api/peer/v1/snapshot", read, ""); w.Code != 200 {
		t.Fatalf("read snapshot: %d", w.Code)
	}
	if w := scopedRequest(h, "POST", "/api/peer/v1/apps/a/start", read, s.ControllerID); w.Code != 403 {
		t.Fatalf("read controlled app: %d", w.Code)
	}
	if w := scopedRequest(h, "POST", "/api/peer/v1/apps/a/start", control, "wrong"); w.Code != 409 {
		t.Fatalf("wrong identity: %d", w.Code)
	}
	for _, tc := range []struct {
		host, origin string
		header       bool
	}{{"evil.example:49153", "", true}, {"192.0.2.1:49153", "https://evil.example", true}, {"192.0.2.1:49153", "", false}} {
		r := httptest.NewRequest("POST", "https://192.0.2.1:49153/api/peer/v1/apps/a/start", nil)
		r.Host = tc.host
		r.Header.Set("Authorization", "Bearer "+control)
		r.Header.Set("Origin", tc.origin)
		if tc.header {
			r.Header.Set("X-Stakl", "1")
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatalf("security bypass %+v: %d", tc, w.Code)
		}
	}
	if w := scopedRequest(h, "GET", "/api/peer/v1/info", read, ""); w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("missing security headers")
	}
}

func TestSetupRoutesAreAdministrativeAndStrict(t *testing.T) {
	s, _ := peerFixture(t)
	s.PeerAccess = peeraccess.New(filepath.Join(s.Manager.Dir, "peer-access.json"), s.PeerHandler)
	t.Cleanup(s.PeerAccess.Close)
	h := s.Handler()
	if w := peerRequest(h, "GET", "/api/peer-access", "", "", ""); w.Code != 401 {
		t.Fatalf("unauthorized status: %d", w.Code)
	}
	w := peerRequest(h, "GET", "/api/peer-access", "admin", "", "")
	if w.Code != 200 || strings.Contains(w.Body.String(), "PRIVATE KEY") || strings.Contains(w.Body.String(), "private_key") {
		t.Fatalf("unsafe status: %d %s", w.Code, w.Body.String())
	}
	for _, body := range []string{`{"address":"127.0.0.1","port":49153}`, `{"address":"192.0.2.1","port":0}`, `{"address":"192.0.2.1","port":49153,"token":"private"}`, `{} {}`, `{"address":12}`} {
		if w := peerRequest(h, "POST", "/api/peer-access/enable", "admin", "", body); w.Code != 400 {
			t.Fatalf("accepted invalid body %s: %d", body, w.Code)
		}
	}
	s.Certificate = &x509.Certificate{}
	s.BindHost = "0.0.0.0"
	w = peerRequest(h, "GET", "/api/peer-access", "admin", "", "")
	var next struct {
		PrimaryNetworkAccess bool `json:"primary_network_access"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &next); err != nil || !next.PrimaryNetworkAccess {
		t.Fatal("missing primary HTTPS warning")
	}
}

func TestPeerListenerDisableAndRevocationLeavePrimaryAvailable(t *testing.T) {
	s, primary := peerFixture(t)
	s.PeerAccess = peeraccess.New(filepath.Join(s.Manager.Dir, "peer-access.json"), s.PeerHandler)
	t.Cleanup(s.PeerAccess.Close)
	addresses := s.PeerAccess.Status().Addresses
	if len(addresses) == 0 {
		t.Skip("no network interface available")
	}
	l, err := net.Listen("tcp", net.JoinHostPort(addresses[0], "0"))
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	status, err := s.PeerAccess.Enable(context.Background(), peeraccess.EnableRequest{Address: addresses[0], Port: port})
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM([]byte(status.CAPEM)) {
		t.Fatal("bad CA")
	}
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots}}, Timeout: 10 * time.Second}
	defer client.CloseIdleConnections()
	id, token := issuePeer(t, primary, "read")
	stream := func() *http.Response {
		req, _ := http.NewRequest("GET", status.Endpoint+"/api/peer/v1/apps/a/logs?follow=true", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != 200 {
			t.Fatalf("logs: %d", resp.StatusCode)
		}
		return resp
	}
	resp := stream()
	done := make(chan struct{})
	go func() { io.Copy(io.Discard, resp.Body); resp.Body.Close(); close(done) }()
	if _, err := s.PeerAccess.Disable(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("disable left stream open")
	}
	if w := peerRequest(primary, "GET", "/api/peer/v1/info", token, "", ""); w.Code != 200 {
		t.Fatal("disable closed primary peer API")
	}
	status, err = s.PeerAccess.Enable(context.Background(), peeraccess.EnableRequest{Address: addresses[0], Port: port})
	if err != nil {
		t.Fatal(err)
	}
	resp = stream()
	done = make(chan struct{})
	go func() { io.Copy(io.Discard, resp.Body); resp.Body.Close(); close(done) }()
	if w := peerRequest(primary, "POST", "/api/peer-tokens/"+id+"/revoke", "admin", "", `{}`); w.Code != 200 {
		t.Fatal("revoke failed")
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("revocation left stream open")
	}
	if w := peerRequest(primary, "GET", "/api/peer-tokens", "admin", "", ""); w.Code != 200 {
		t.Fatal("local administration unavailable")
	}
}
