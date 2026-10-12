package hosts

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func peerInfo() Info {
	return Info{ControllerID: "peer-one", Protocol: 1, Version: "diagnostic", Platform: "test", Access: "control"}
}

func peerClient(t *testing.T, endpoint, ca string) *Client {
	t.Helper()
	c, err := NewClient(endpoint, "private-peer-token", ca, "peer-one")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.http.CloseIdleConnections)
	return c
}

func assertHostError(t *testing.T, err error, state ConnectionState, unknown bool) *HostError {
	t.Helper()
	var hostErr *HostError
	if !errors.As(err, &hostErr) || hostErr.State != state || hostErr.OutcomeUnknown != unknown {
		t.Fatalf("error = %#v, want state %q and outcome unknown %v", err, state, unknown)
	}
	if strings.Contains(hostErr.Error(), "private-peer-token") {
		t.Fatal("error revealed peer token")
	}
	return hostErr
}

func TestPeerEndpointValidation(t *testing.T) {
	for _, endpoint := range []string{
		"http://127.0.0.1:1234", "http://127.0.0.2/", "http://[::1]:1234", "http://localhost:1234",
		"https://example.com", "https://192.0.2.1:443/", "https://[2001:db8::1]:443",
	} {
		t.Run(endpoint, func(t *testing.T) {
			if _, err := NewClient(endpoint, "token", "", ""); err != nil {
				t.Fatal(err)
			}
		})
	}
	for _, endpoint := range []string{
		"http://192.0.2.1", "http://example.com", "ftp://127.0.0.1", "//localhost", "https://",
		"https://user:private-peer-token@example.com", "https://example.com?q=token", "https://example.com?",
		"https://example.com#token", "https://example.com/path", "https://example.com/%2f", "https://example.com:0",
		"https://example.com:65536", "https://example.com:", "https://example.com:bad", "http://[::1%25zone]",
	} {
		t.Run(endpoint, func(t *testing.T) {
			_, err := NewClient(endpoint, "private-peer-token", "", "")
			assertHostError(t, err, StateUnavailable, false)
		})
	}

	t.Run("localhost must resolve only to loopback", func(t *testing.T) {
		lookup := func(context.Context, string) ([]net.IPAddr, error) {
			return []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}, {IP: net.ParseIP("192.0.2.1")}}, nil
		}
		_, err := newClient("http://localhost:1234", "token", "", "", lookup)
		assertHostError(t, err, StateUnavailable, false)
	})

	t.Run("localhost resolution is checked again at dial", func(t *testing.T) {
		var requests atomic.Int32
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests.Add(1) }))
		defer s.Close()
		endpoint := strings.Replace(s.URL, "127.0.0.1", "localhost", 1)
		ip := "127.0.0.1"
		lookup := func(context.Context, string) ([]net.IPAddr, error) {
			return []net.IPAddr{{IP: net.ParseIP(ip)}}, nil
		}
		c, err := newClient(endpoint, "private-peer-token", "", "peer-one", lookup)
		if err != nil {
			t.Fatal(err)
		}
		defer c.http.CloseIdleConnections()
		ip = "192.0.2.1"
		_, err = c.Info(context.Background())
		assertHostError(t, err, StateUnavailable, false)
		if requests.Load() != 0 {
			t.Fatal("dial accepted changed non-loopback DNS")
		}
	})
}

func TestPeerTLSRootsAndSAN(t *testing.T) {
	s := quietTLSPeer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { json.NewEncoder(w).Encode(peerInfo()) }))
	defer s.Close()
	trusted := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: s.Certificate().Raw}))
	if _, err := peerClient(t, s.URL, trusted).Info(context.Background()); err != nil {
		t.Fatal(err)
	}
	for name, ca := range map[string]string{"system roots do not trust peer": "", "wrong CA": unrelatedCA(t)} {
		t.Run(name, func(t *testing.T) {
			_, err := peerClient(t, s.URL, ca).Info(context.Background())
			assertHostError(t, err, StateUnavailable, false)
		})
	}
	t.Run("trusted certificate requires matching hostname", func(t *testing.T) {
		endpoint := strings.Replace(s.URL, "127.0.0.1", "localhost", 1)
		_, err := peerClient(t, endpoint, trusted).Info(context.Background())
		assertHostError(t, err, StateUnavailable, false)
	})
	if _, err := NewClient(s.URL, "token", "not PEM", ""); err == nil {
		t.Fatal("accepted invalid trust PEM")
	}
}

func quietTLSPeer(handler http.Handler) *httptest.Server {
	s := httptest.NewUnstartedServer(handler)
	s.Config.ErrorLog = log.New(io.Discard, "", 0)
	s.StartTLS()
	return s
}

func unrelatedCA(t *testing.T) string {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	cert := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "unrelated"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}

func TestPeerNoRedirectOrProxy(t *testing.T) {
	var redirectTargetRequests, proxyRequests atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirectTargetRequests.Add(1) }))
	defer target.Close()
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { proxyRequests.Add(1) }))
	defer proxy.Close()
	t.Setenv("HTTP_PROXY", proxy.URL)
	t.Setenv("HTTPS_PROXY", proxy.URL)
	t.Setenv("NO_PROXY", "")
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	_, err := peerClient(t, redirect.URL, "").Info(context.Background())
	assertHostError(t, err, StateUnavailable, false)
	if redirectTargetRequests.Load() != 0 {
		t.Fatal("forwarded credentials across redirect")
	}
	// Use a certificate DNS SAN, not loopback, to avoid net/http's automatic proxy exemption.
	tlsPeer := quietTLSPeer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { json.NewEncoder(w).Encode(peerInfo()) }))
	defer tlsPeer.Close()
	ca := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: tlsPeer.Certificate().Raw}))
	c := peerClient(t, strings.Replace(tlsPeer.URL, "127.0.0.1", "example.com", 1), ca)
	transport := c.http.Transport.(*http.Transport)
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		if address == proxy.Listener.Addr().String() {
			return (&net.Dialer{}).DialContext(ctx, network, address)
		}
		return (&net.Dialer{}).DialContext(ctx, network, tlsPeer.Listener.Addr().String())
	}
	if _, err := c.Info(context.Background()); err != nil {
		t.Fatal(err)
	}
	if proxyRequests.Load() != 0 {
		t.Fatal("peer request inherited a proxy")
	}
}

func TestPeerTimeoutAndBodyLimit(t *testing.T) {
	t.Run("snapshot body bounded even with valid leading JSON", func(t *testing.T) {
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			json.NewEncoder(w).Encode(Snapshot{Info: peerInfo()})
			io.WriteString(w, strings.Repeat(" ", 16*1024*1024))
		}))
		defer s.Close()
		_, err := peerClient(t, s.URL, "").Snapshot(context.Background())
		assertHostError(t, err, StateUnavailable, false)
	})
	t.Run("snapshot has total five second deadline", func(t *testing.T) {
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			w.(http.Flusher).Flush()
			<-r.Context().Done()
		}))
		defer s.Close()
		start := time.Now()
		_, err := peerClient(t, s.URL, "").Snapshot(context.Background())
		assertHostError(t, err, StateUnavailable, false)
		if elapsed := time.Since(start); elapsed < 4*time.Second || elapsed > 7*time.Second {
			t.Fatalf("snapshot deadline elapsed %s", elapsed)
		}
	})
	t.Run("caller cancels header wait", func(t *testing.T) {
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
		defer s.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
		defer cancel()
		_, err := peerClient(t, s.URL, "").Info(ctx)
		assertHostError(t, err, StateUnavailable, false)
	})
	t.Run("caller cancels active stream", func(t *testing.T) {
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.HasSuffix(r.URL.Path, "/info") {
				json.NewEncoder(w).Encode(peerInfo())
				return
			}
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			w.(http.Flusher).Flush()
			<-r.Context().Done()
		}))
		defer s.Close()
		ctx, cancel := context.WithCancel(context.Background())
		response, err := peerClient(t, s.URL, "").ReadApp(ctx, "api", "logs", url.Values{"follow": {"true"}}, "")
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		cancel()
		if _, err := response.Body.Read(make([]byte, 1)); err == nil {
			t.Fatal("stream survived caller cancellation")
		}
	})
}

func TestPeerMutationNeverRetries(t *testing.T) {
	var postAttempts atomic.Int32
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			json.NewEncoder(w).Encode(peerInfo())
			return
		}
		postAttempts.Add(1)
		if r.Header.Get("X-Stakl-Peer-ID") != "peer-one" || r.Header.Get("X-Stakl") != "1" || r.Header.Get("Authorization") != "Bearer private-peer-token" {
			t.Error("mutation omitted identity/authentication headers")
		}
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		conn.Close()
	}))
	defer s.Close()
	_, err := peerClient(t, s.URL, "").Mutate(context.Background(), "api", "restart")
	assertHostError(t, err, StateUnavailable, true)
	if postAttempts.Load() != 1 {
		t.Fatal("ambiguous mutation was repeated or misreported")
	}
}

// A zero-byte write failure on a reused connection exercises net/http's retry
// branch deterministically, without racing a TCP close against the next POST.
type failedPostConnection struct {
	net.Conn
	writes *atomic.Int32
}

func (c *failedPostConnection) Write(p []byte) (int, error) {
	if bytes.HasPrefix(p, []byte("POST ")) {
		c.writes.Add(1)
		return 0, io.ErrClosedPipe
	}
	return c.Conn.Write(p)
}

func TestPeerMutationNeverRetriesStaleWrite(t *testing.T) {
	var postWrites, postAttempts atomic.Int32
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			json.NewEncoder(w).Encode(peerInfo())
			return
		}
		postAttempts.Add(1)
		json.NewEncoder(w).Encode(LifecycleResponse{Info: peerInfo(), Results: map[string]string{"api": "started"}})
	}))
	defer s.Close()
	c := peerClient(t, s.URL, "")
	transport := c.http.Transport.(*http.Transport)
	dial := transport.DialContext
	failWrite := func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := dial(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return &failedPostConnection{Conn: conn, writes: &postWrites}, nil
	}
	transport.DialContext = failWrite
	c.mutationHTTP.Transport.(*http.Transport).DialContext = failWrite
	_, err := c.Mutate(context.Background(), "api", "start")
	assertHostError(t, err, StateUnavailable, true)
	if postWrites.Load() != 1 || postAttempts.Load() != 0 {
		t.Fatal("mutation automatically retried after a stale connection write")
	}
}

func TestPeerMutationUsesFreshHTTP1Connections(t *testing.T) {
	var mu sync.Mutex
	addresses := make(map[string]bool)
	s := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			json.NewEncoder(w).Encode(peerInfo())
			return
		}
		if r.ProtoMajor != 1 {
			t.Error("mutation negotiated HTTP/2")
		}
		mu.Lock()
		addresses[r.RemoteAddr] = true
		mu.Unlock()
		json.NewEncoder(w).Encode(LifecycleResponse{Info: peerInfo(), Results: map[string]string{"api": "started"}})
	}))
	s.EnableHTTP2 = true
	s.Config.ErrorLog = log.New(io.Discard, "", 0)
	s.StartTLS()
	defer s.Close()
	ca := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: s.Certificate().Raw}))
	c := peerClient(t, s.URL, ca)
	for range 2 {
		if _, err := c.Mutate(context.Background(), "api", "start"); err != nil {
			t.Fatal(err)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(addresses) != 2 {
		t.Fatal("lifecycle requests reused a connection")
	}
}

func TestPeerIdentityProtocolAndSafeErrors(t *testing.T) {
	for _, tc := range []struct {
		name  string
		info  Info
		state ConnectionState
	}{
		{"identity", Info{ControllerID: "replacement", Protocol: 1, Access: "control"}, StateIdentityMismatch},
		{"protocol", Info{ControllerID: "peer-one", Protocol: 2, Access: "control"}, StateIncompatible},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var posts atomic.Int32
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodPost {
					posts.Add(1)
				}
				if strings.HasSuffix(r.URL.Path, "/snapshot") {
					json.NewEncoder(w).Encode(Snapshot{Info: tc.info})
					return
				}
				json.NewEncoder(w).Encode(tc.info)
			}))
			defer s.Close()
			c := peerClient(t, s.URL, "")
			_, err := c.Info(context.Background())
			assertHostError(t, err, tc.state, false)
			_, err = c.Snapshot(context.Background())
			assertHostError(t, err, tc.state, false)
			_, err = c.Mutate(context.Background(), "api", "start")
			assertHostError(t, err, tc.state, false)
			_, err = c.ReadApp(context.Background(), "api", "health", nil, "")
			assertHostError(t, err, tc.state, false)
			if posts.Load() != 0 {
				t.Fatal("mutation forwarded before identity/protocol check")
			}
		})
	}
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusConflict, http.StatusInternalServerError} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "private-peer-token", status) }))
			defer s.Close()
			_, err := peerClient(t, s.URL, "").Info(context.Background())
			state := StateUnavailable
			if status == 401 || status == 403 {
				state = StateUnauthorized
			}
			if status == 409 {
				state = StateIdentityMismatch
			}
			if got := assertHostError(t, err, state, false).StatusCode; got != status {
				t.Fatalf("status = %d", got)
			}
		})
	}
}

func TestPeerMutationRejectsMissingOutcomes(t *testing.T) {
	for _, tc := range []struct {
		name    string
		present bool
		results map[string]string
	}{
		{name: "missing"},
		{name: "null", present: true},
		{name: "empty", present: true, results: map[string]string{}},
		{name: "unrelated_only", present: true, results: map[string]string{"dependency": "already running"}},
		{name: "empty_target", present: true, results: map[string]string{"api": "", "dependency": "already running"}},
		{name: "whitespace_target", present: true, results: map[string]string{"api": " \t\n", "dependency": "already running"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var postAttempts atomic.Int32
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodGet {
					json.NewEncoder(w).Encode(peerInfo())
					return
				}
				postAttempts.Add(1)
				response := map[string]any{"info": peerInfo()}
				if tc.present {
					response["results"] = tc.results
				}
				json.NewEncoder(w).Encode(response)
			}))
			defer s.Close()
			_, err := peerClient(t, s.URL, "").Mutate(context.Background(), "api", "start")
			assertHostError(t, err, StateIncompatible, true)
			if postAttempts.Load() != 1 {
				t.Fatal("invalid lifecycle response caused a retry")
			}
		})
	}
}

func TestPeerMutationPreservesTargetAndDependencyOutcomes(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			json.NewEncoder(w).Encode(peerInfo())
			return
		}
		json.NewEncoder(w).Encode(LifecycleResponse{Info: peerInfo(), Results: map[string]string{"api": "started", "dependency": "already running"}})
	}))
	defer s.Close()
	result, err := peerClient(t, s.URL, "").Mutate(context.Background(), "api", "start")
	if err != nil || result.Results["api"] != "started" || result.Results["dependency"] != "already running" || len(result.Results) != 2 {
		t.Fatalf("target/dependency outcomes = %+v, error = %v", result, err)
	}
}

func TestPeerFixedPathsAndLifecycleResult(t *testing.T) {
	var readPath, actionPath, query, lastID string
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer private-peer-token" {
			t.Error("missing bearer credential")
		}
		if r.URL.Path == "/api/peer/v1/info" {
			json.NewEncoder(w).Encode(peerInfo())
			return
		}
		if r.Method == http.MethodPost {
			actionPath = r.URL.EscapedPath()
			json.NewEncoder(w).Encode(LifecycleResponse{Info: peerInfo(), Results: map[string]string{"api/../secret?x#y": "started", "dependency": "already running"}})
			return
		}
		readPath, query, lastID = r.URL.EscapedPath(), r.URL.RawQuery, r.Header.Get("Last-Event-ID")
		io.WriteString(w, "event: log\nid: 99\ndata: hello\n\n")
	}))
	defer s.Close()
	c := peerClient(t, s.URL, "")
	response, err := c.ReadApp(context.Background(), "api/../secret?x#y", "logs", url.Values{"follow": {"true"}, "source": {"stderr"}}, "98")
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || !strings.Contains(string(body), "id: 99") || readPath != "/api/peer/v1/apps/api%2F..%2Fsecret%3Fx%23y/logs" || query != "follow=true&source=stderr" || lastID != "98" {
		t.Fatalf("unsafe/lost read path or stream metadata: %q %q %q %v", readPath, query, lastID, err)
	}
	result, err := c.Mutate(context.Background(), "api/../secret?x#y", "start")
	if err != nil || result.Results["api/../secret?x#y"] != "started" || result.Results["dependency"] != "already running" || actionPath != "/api/peer/v1/apps/api%2F..%2Fsecret%3Fx%23y/start" {
		t.Fatalf("lifecycle result/path = %+v, %q, %v", result, actionPath, err)
	}
	for _, resource := range []string{"config", "https://example.com", "../history", ""} {
		if _, err := c.ReadApp(context.Background(), "api", resource, nil, ""); err == nil {
			t.Fatalf("accepted resource %q", resource)
		}
	}
	for _, action := range []string{"kill", "../start", "https://example.com", ""} {
		if _, err := c.Mutate(context.Background(), "api", action); err == nil {
			t.Fatalf("accepted action %q", action)
		}
	}
}
