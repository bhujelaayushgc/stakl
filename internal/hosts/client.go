package hosts

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	peerWait          = 5 * time.Second
	peerLifecycleWait = 2 * time.Minute
	peerStreamIdle    = 45 * time.Second
	peerBodyLimit     = 16 * 1024 * 1024
)

// Client connects only to one validated peer endpoint. It never uses inherited
// proxies or redirects, and HTTPS always uses normal chain and SAN verification.
type Client struct {
	endpoint     *url.URL
	token        string
	expectedID   string
	http         *http.Client
	mutationHTTP *http.Client
}

func NewClient(endpoint, token, caPEM string, expectedControllerID string) (*Client, error) {
	return newClient(endpoint, token, caPEM, expectedControllerID, net.DefaultResolver.LookupIPAddr)
}

func newClient(endpoint, token, caPEM string, expectedControllerID string, lookup func(context.Context, string) ([]net.IPAddr, error)) (*Client, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u == nil || (u.Scheme != "https" && u.Scheme != "http") || u.Opaque != "" || u.Hostname() == "" || u.User != nil ||
		(u.Path != "" && u.Path != "/") || u.RawPath != "" || u.RawQuery != "" || u.ForceQuery || strings.Contains(endpoint, "#") {
		return nil, unavailable("Invalid peer endpoint")
	}
	if strings.HasSuffix(u.Host, ":") {
		return nil, unavailable("Invalid peer endpoint port")
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return nil, unavailable("Invalid peer endpoint port")
		}
	}
	if token == "" || strings.ContainsAny(token, " \t\r\n") {
		return nil, unavailable("Invalid peer credential")
	}
	if u.Scheme == "http" {
		ctx, cancel := context.WithTimeout(context.Background(), peerWait)
		defer cancel()
		if _, err := loopbackAddresses(ctx, u.Hostname(), lookup); err != nil {
			return nil, err
		}
	}
	roots, err := x509.SystemCertPool()
	if err != nil {
		return nil, unavailable("System certificate trust is unavailable")
	}
	if caPEM != "" && !roots.AppendCertsFromPEM([]byte(caPEM)) {
		return nil, unavailable("Invalid peer certificate trust")
	}
	dialer := &net.Dialer{Timeout: peerWait, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		Proxy:                 nil,
		DialContext:           dialer.DialContext,
		TLSClientConfig:       &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12},
		TLSHandshakeTimeout:   peerWait,
		ResponseHeaderTimeout: peerWait,
		IdleConnTimeout:       90 * time.Second,
		MaxIdleConns:          16,
		MaxIdleConnsPerHost:   4,
	}
	if u.Scheme == "http" {
		// Resolve and validate immediately before dialing. Dial those numeric
		// addresses directly so a second DNS lookup cannot bypass the check.
		transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			ctx, cancel := context.WithTimeout(ctx, peerWait)
			defer cancel()
			host, port, err := net.SplitHostPort(address)
			if err != nil {
				return nil, unavailable("Invalid peer address")
			}
			ips, err := loopbackAddresses(ctx, host, lookup)
			if err != nil {
				return nil, err
			}
			for _, ip := range ips {
				conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
				if err == nil {
					return conn, nil
				}
			}
			return nil, unavailable("Peer connection failed")
		}
	}
	noRedirect := func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	mutationTransport := transport.Clone()
	mutationTransport.DisableKeepAlives = true
	mutationTransport.Protocols = new(http.Protocols)
	mutationTransport.Protocols.SetHTTP1(true)
	return &Client{
		endpoint: u, token: token, expectedID: expectedControllerID,
		http:         &http.Client{Transport: transport, CheckRedirect: noRedirect},
		mutationHTTP: &http.Client{Transport: mutationTransport, CheckRedirect: noRedirect},
	}, nil
}

func loopbackAddresses(ctx context.Context, hostname string, lookup func(context.Context, string) ([]net.IPAddr, error)) ([]net.IP, error) {
	if ip := net.ParseIP(hostname); ip != nil && ip.IsLoopback() {
		return []net.IP{ip}, nil
	}
	if !strings.EqualFold(hostname, "localhost") {
		return nil, unavailable("Plaintext peer endpoints require loopback")
	}
	resolved, err := lookup(ctx, hostname)
	if err != nil || len(resolved) == 0 {
		return nil, unavailable("Could not verify localhost addresses")
	}
	ips := make([]net.IP, 0, len(resolved))
	for _, address := range resolved {
		if !address.IP.IsLoopback() || address.Zone != "" {
			return nil, unavailable("Plaintext peer endpoints require loopback")
		}
		ips = append(ips, address.IP)
	}
	return ips, nil
}

func (c *Client) Info(ctx context.Context) (Info, error) {
	ctx, cancel := context.WithTimeout(ctx, peerWait)
	defer cancel()
	var info Info
	if err := c.jsonRequest(ctx, http.MethodGet, "/api/peer/v1/info", &info, false); err != nil {
		return Info{}, err
	}
	if err := c.checkInfo(info); err != nil {
		return Info{}, err
	}
	return info, nil
}

func (c *Client) Snapshot(ctx context.Context) (Snapshot, error) {
	ctx, cancel := context.WithTimeout(ctx, peerWait)
	defer cancel()
	var snapshot Snapshot
	if err := c.jsonRequest(ctx, http.MethodGet, "/api/peer/v1/snapshot", &snapshot, false); err != nil {
		return Snapshot{}, err
	}
	if err := c.checkInfo(snapshot.Info); err != nil {
		return Snapshot{}, err
	}
	return snapshot, nil
}

// ReadApp owns the response context until its body is closed. Callers must close
// the body, and cancel the parent context when a forwarded browser disconnects.
func (c *Client) ReadApp(ctx context.Context, appID, resource string, query url.Values, lastEventID string) (*http.Response, error) {
	if resource != "app" && resource != "health" && resource != "history" && resource != "logs" {
		return nil, unavailable("Unsupported peer resource")
	}
	path, err := appPath(appID)
	if err != nil {
		return nil, err
	}
	if resource != "app" {
		path += "/" + resource
	}
	stream := resource == "logs" && (query.Get("follow") == "true" || query.Get("download") == "true")
	var cancel context.CancelFunc
	if stream {
		ctx, cancel = context.WithCancel(ctx)
	} else {
		ctx, cancel = context.WithTimeout(ctx, peerWait)
	}
	if _, err := c.Info(ctx); err != nil {
		cancel()
		return nil, err
	}
	req, err := c.request(ctx, http.MethodGet, path, query)
	if err != nil {
		cancel()
		return nil, err
	}
	req.Header.Set("Last-Event-ID", lastEventID)
	response, err := c.http.Do(req)
	if err != nil {
		cancel()
		return nil, unavailable("Peer read failed")
	}
	if err := responseError(response.StatusCode, false); err != nil {
		response.Body.Close()
		cancel()
		return nil, err
	}
	body := &peerBody{ReadCloser: response.Body, cancel: cancel, remaining: peerBodyLimit}
	if stream {
		body.remaining = -1
		body.timer = time.AfterFunc(peerStreamIdle, cancel)
	}
	response.Body = body
	return response, nil
}

func (c *Client) Mutate(ctx context.Context, appID, action string) (PeerActionResult, error) {
	if action != "start" && action != "stop" && action != "restart" {
		return PeerActionResult{}, unavailable("Unsupported peer action")
	}
	path, err := appPath(appID)
	if err != nil {
		return PeerActionResult{}, err
	}
	if c.expectedID == "" {
		return PeerActionResult{}, unavailable("Peer identity is required for lifecycle requests")
	}
	ctx, cancel := context.WithTimeout(ctx, peerLifecycleWait)
	defer cancel()
	info, err := c.Info(ctx)
	if err != nil {
		return PeerActionResult{}, err
	}
	if info.Access != "control" {
		return PeerActionResult{}, &HostError{Message: "Peer control access is required", State: StateUnauthorized, StatusCode: http.StatusForbidden}
	}
	var result PeerActionResult
	if err := c.jsonRequest(ctx, http.MethodPost, path+"/"+action, &result, true); err != nil {
		return PeerActionResult{}, err
	}
	if err := c.checkInfo(result.Info); err != nil {
		err.(*HostError).OutcomeUnknown = true
		return PeerActionResult{}, err
	}
	if result.Results == nil {
		return PeerActionResult{}, &HostError{Message: "Peer lifecycle outcomes are missing", State: StateIncompatible, StatusCode: http.StatusOK, OutcomeUnknown: true}
	}
	return result, nil
}

func appPath(appID string) (string, error) {
	if appID == "" || appID == "." || appID == ".." {
		return "", unavailable("Invalid peer application ID")
	}
	return "/api/peer/v1/apps/" + url.PathEscape(appID), nil
}

func (c *Client) request(ctx context.Context, method, path string, query url.Values) (*http.Request, error) {
	u := *c.endpoint
	decoded, err := url.PathUnescape(path)
	if err != nil {
		return nil, unavailable("Invalid peer request")
	}
	u.Path, u.RawPath, u.RawQuery = decoded, path, query.Encode()
	req, err := http.NewRequestWithContext(ctx, method, u.String(), nil)
	if err != nil {
		return nil, unavailable("Invalid peer request")
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if method == http.MethodPost {
		req.Header.Set("X-Stakl", "1")
		req.Header.Set("X-Stakl-Peer-ID", c.expectedID)
	}
	return req, nil
}

func (c *Client) jsonRequest(ctx context.Context, method, path string, out any, mutation bool) error {
	req, err := c.request(ctx, method, path, nil)
	if err != nil {
		return err
	}
	client := c.http
	if mutation {
		// Even a bodyless POST may be retried after a zero-byte write on a reused
		// connection. A fresh HTTP/1 connection prevents transport-level retries.
		client = c.mutationHTTP
	}
	response, err := client.Do(req)
	if err != nil {
		return &HostError{Message: "Peer request failed", State: StateUnavailable, OutcomeUnknown: mutation}
	}
	defer response.Body.Close()
	if err := responseError(response.StatusCode, mutation); err != nil {
		return err
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, peerBodyLimit+1))
	if err != nil || len(body) > peerBodyLimit {
		return &HostError{Message: "Peer response was incomplete or too large", State: StateUnavailable, StatusCode: response.StatusCode, OutcomeUnknown: mutation}
	}
	if err := json.Unmarshal(body, out); err != nil {
		return &HostError{Message: "Invalid peer response", State: StateIncompatible, StatusCode: response.StatusCode, OutcomeUnknown: mutation}
	}
	return nil
}

func (c *Client) checkInfo(info Info) error {
	if info.Protocol != 1 || info.ControllerID == "" || (info.Access != "read" && info.Access != "control") {
		return &HostError{Message: "Incompatible peer protocol", State: StateIncompatible}
	}
	if c.expectedID != "" && info.ControllerID != c.expectedID {
		return &HostError{Message: "Peer controller identity changed", State: StateIdentityMismatch}
	}
	return nil
}

func unavailable(message string) *HostError {
	return &HostError{Message: message, State: StateUnavailable}
}

func responseError(status int, mutation bool) error {
	if status >= 200 && status < 300 {
		return nil
	}
	e := &HostError{Message: "Peer request was rejected", State: StateUnavailable, StatusCode: status, OutcomeUnknown: mutation && status >= 500}
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		e.State, e.Message = StateUnauthorized, "Peer authorization failed"
	case http.StatusConflict:
		e.State, e.Message = StateIdentityMismatch, "Peer controller identity changed"
	}
	return e
}

// peerBody enforces bounded ordinary reads and a cancelable idle interval for
// log streams/downloads. The idle timer also runs when callers stop reading.
type peerBody struct {
	io.ReadCloser
	cancel    context.CancelFunc
	remaining int64
	mu        sync.Mutex
	timer     *time.Timer
	closed    bool
}

func (b *peerBody) Read(p []byte) (int, error) {
	if b.remaining == 0 {
		var probe [1]byte
		n, err := b.ReadCloser.Read(probe[:])
		if n > 0 {
			b.Close()
			return 0, unavailable("Peer response was too large")
		}
		return 0, err
	}
	if b.remaining > 0 && int64(len(p)) > b.remaining {
		p = p[:b.remaining]
	}
	n, err := b.ReadCloser.Read(p)
	if b.remaining > 0 {
		b.remaining -= int64(n)
	}
	if n > 0 {
		b.mu.Lock()
		if b.timer != nil && !b.closed {
			b.timer.Reset(peerStreamIdle)
		}
		b.mu.Unlock()
	}
	if err != nil && !errors.Is(err, io.EOF) {
		return n, unavailable("Peer read interrupted")
	}
	return n, err
}

func (b *peerBody) Close() error {
	b.mu.Lock()
	b.closed = true
	if b.timer != nil {
		b.timer.Stop()
	}
	b.mu.Unlock()
	b.cancel()
	return b.ReadCloser.Close()
}
