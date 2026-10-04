// Package peeraccess owns the independently configured HTTPS peer listener.
package peeraccess

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/bhujelaayushgc/stakl/internal/supervisor"
	"github.com/bhujelaayushgc/stakl/internal/tlsutil"
)

type EnableRequest struct {
	Address            string `json:"address"`
	Port               int    `json:"port"`
	ReplaceCertificate bool   `json:"replace_certificate"`
}

// Status is deliberately separate from settings: it cannot serialize a key.
type Status struct {
	Enabled              bool     `json:"enabled"`
	Running              bool     `json:"running"`
	Address              string   `json:"address"`
	Port                 int      `json:"port"`
	Endpoint             string   `json:"endpoint"`
	CAPEM                string   `json:"ca_pem"`
	CertificateExpiresAt string   `json:"certificate_expires_at"`
	HasCertificate       bool     `json:"has_certificate"`
	Addresses            []string `json:"addresses"`
	Error                string   `json:"error"`
}

type Failure struct {
	Code, Message string
	Status        int
}

func (e *Failure) Error() string { return e.Message }
func failure(code, message string, status int) error {
	return &Failure{Code: code, Message: message, Status: status}
}

type settings struct {
	Enabled        bool   `json:"enabled"`
	Address        string `json:"address"`
	Port           int    `json:"port"`
	CertificatePEM string `json:"certificate_pem"`
	PrivateKeyPEM  string `json:"private_key_pem"`
}
type runtime struct {
	server   *http.Server
	cancel   context.CancelFunc
	listener net.Listener
}
type Controller struct {
	mu                 sync.Mutex
	path               string
	handler            func(string) http.Handler
	addresses          func() ([]string, error)
	write              func(string, any) error
	settings           settings
	root               context.Context
	live               *runtime
	lastError          string
	loadFailed, closed bool
}

func New(path string, handler func(address string) http.Handler) *Controller {
	return &Controller{path: path, handler: handler, addresses: localAddresses, write: supervisor.AtomicJSON, settings: settings{Port: 49153}, root: context.Background()}
}

func usableAddress(address string) bool {
	ip := net.ParseIP(address)
	return ip != nil && ip.IsGlobalUnicast() && !ip.IsLoopback() && !ip.IsLinkLocalUnicast()
}
func localAddresses() ([]string, error) {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addresses, err := iface.Addrs()
		if err != nil {
			return nil, err
		}
		for _, address := range addresses {
			ip, _, err := net.ParseCIDR(address.String())
			if err == nil && usableAddress(ip.String()) {
				seen[ip.String()] = true
			}
		}
	}
	result := make([]string, 0, len(seen))
	for address := range seen {
		result = append(result, address)
	}
	sort.Slice(result, func(i, j int) bool {
		a, b := net.ParseIP(result[i]).To4() != nil, net.ParseIP(result[j]).To4() != nil
		if a != b {
			return a
		}
		return result[i] < result[j]
	})
	return result, nil
}

func (c *Controller) Status() Status { c.mu.Lock(); defer c.mu.Unlock(); return c.statusLocked() }
func (c *Controller) statusLocked() Status {
	addresses, err := c.addresses()
	if addresses == nil {
		addresses = []string{}
	}
	s := Status{Enabled: c.settings.Enabled, Running: c.live != nil, Address: c.settings.Address, Port: c.settings.Port, HasCertificate: c.settings.CertificatePEM != "" || c.settings.PrivateKeyPEM != "", Addresses: addresses, Error: c.lastError}
	if c.settings.Address != "" {
		s.Endpoint = "https://" + net.JoinHostPort(c.settings.Address, strconv.Itoa(c.settings.Port))
	}
	// Only emit a parsed CERTIFICATE block, even if the saved file is damaged.
	if block, _ := pem.Decode([]byte(c.settings.CertificatePEM)); block != nil && block.Type == "CERTIFICATE" {
		if cert, e := x509.ParseCertificate(block.Bytes); e == nil {
			s.CAPEM = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Raw}))
			s.CertificateExpiresAt = cert.NotAfter.UTC().Format(time.RFC3339)
		}
	}
	if err != nil && s.Error == "" {
		s.Error = "Could not list network addresses. Check this machine's network connection."
	}
	return s
}

// Restore records failures so the primary dashboard can always start normally.
func (c *Controller) Restore(ctx context.Context) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || c.live != nil {
		return
	}
	c.root = ctx
	file, err := os.Open(c.path)
	if errors.Is(err, os.ErrNotExist) {
		return
	}
	if err == nil {
		defer file.Close()
		var info os.FileInfo
		info, err = file.Stat()
		if err == nil && (!info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0) {
			err = fmt.Errorf("unsafe settings permissions")
		}
		if err == nil {
			decoder := json.NewDecoder(io.LimitReader(file, 2*1024*1024))
			decoder.DisallowUnknownFields()
			var saved settings
			err = decoder.Decode(&saved)
			if err == nil {
				var extra any
				if decoder.Decode(&extra) != io.EOF {
					err = fmt.Errorf("invalid trailing settings")
				}
			}
			if err == nil {
				c.settings = saved
			}
		}
	}
	if err != nil {
		c.loadFailed = true
		c.lastError = "Could not read private host access settings. Disable access to reset them, then enable again."
		return
	}
	if !c.settings.Enabled {
		return
	}
	if err := c.validate(c.settings.Address, c.settings.Port); err != nil {
		c.lastError = err.Error()
		return
	}
	config, err := certificateConfig(c.settings)
	if err != nil {
		c.lastError = "Saved certificate cannot be used. Enable access with explicit certificate replacement, then update trust on connected dashboards."
		return
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(c.settings.Address, strconv.Itoa(c.settings.Port)))
	if err != nil {
		c.lastError = "Could not open the peer endpoint. Check that its address is available and its port is not in use."
		return
	}
	c.startLocked(listener, config)
}

func (c *Controller) validate(address string, port int) error {
	if port < 1 || port > 65535 {
		return failure("invalid_port", "Choose a port between 1 and 65535.", 400)
	}
	ip := net.ParseIP(address)
	if ip == nil || ip.String() != address {
		return failure("invalid_address", "Choose one of this machine's available network IP addresses.", 400)
	}
	addresses, err := c.addresses()
	if err != nil {
		return failure("network_unavailable", "Could not list this machine's network addresses.", 503)
	}
	for _, available := range addresses {
		if available == address {
			return nil
		}
	}
	return failure("address_unavailable", "That network address is no longer available on this machine. Choose an available address.", 400)
}
func certificateConfig(saved settings) (*tls.Config, error) {
	pair, err := tls.X509KeyPair([]byte(saved.CertificatePEM), []byte(saved.PrivateKeyPEM))
	if err != nil {
		return nil, err
	}
	cert, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return nil, err
	}
	roots := x509.NewCertPool()
	roots.AddCert(cert)
	if _, err := cert.Verify(x509.VerifyOptions{DNSName: saved.Address, Roots: roots}); err != nil {
		return nil, err
	}
	if !cert.IsCA {
		return nil, fmt.Errorf("certificate is not a trusted CA")
	}
	return &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{pair}}, nil
}

func (c *Controller) Enable(ctx context.Context, request EnableRequest) (Status, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return c.statusLocked(), failure("closed", "The controller is shutting down.", 503)
	}
	if c.loadFailed {
		return c.statusLocked(), failure("invalid_settings", c.lastError, 409)
	}
	if c.live != nil {
		if request.Address == c.settings.Address && request.Port == c.settings.Port && !request.ReplaceCertificate {
			return c.statusLocked(), nil
		}
		return c.statusLocked(), failure("already_running", "Disable access before changing its address, port, or certificate.", 409)
	}
	if err := c.validate(request.Address, request.Port); err != nil {
		return c.statusLocked(), err
	}
	next := c.settings
	next.Enabled = true
	next.Address = request.Address
	next.Port = request.Port
	config, err := certificateConfig(next)
	hasSaved := next.CertificatePEM != "" || next.PrivateKeyPEM != ""
	if err != nil && hasSaved && !request.ReplaceCertificate {
		return c.statusLocked(), failure("certificate_replace_required", "The saved certificate is expired, damaged, or does not cover this address. Replace it explicitly and update certificate trust on connected dashboards.", 409)
	}
	if !hasSaved || request.ReplaceCertificate {
		addresses, err := c.addresses()
		if err != nil {
			return c.statusLocked(), failure("network_unavailable", "Could not list network addresses.", 503)
		}
		cert, key, err := tlsutil.Generate(append([]string{next.Address}, addresses...))
		if err != nil {
			return c.statusLocked(), failure("certificate_failed", "Could not generate a peer certificate. Try enabling again.", 500)
		}
		next.CertificatePEM = string(cert)
		next.PrivateKeyPEM = string(key)
		config, err = certificateConfig(next)
		if err != nil {
			return c.statusLocked(), failure("certificate_failed", "Could not validate the generated certificate.", 500)
		}
	}
	listener, err := (&net.ListenConfig{}).Listen(ctx, "tcp", net.JoinHostPort(next.Address, strconv.Itoa(next.Port)))
	if err != nil {
		return c.statusLocked(), failure("bind_failed", "Could not open the peer endpoint. Check that the address is available and choose a port that is not in use.", 409)
	}
	if err := c.write(c.path, next); err != nil {
		listener.Close()
		return c.statusLocked(), failure("save_failed", "Could not save private host access settings. Check the controller data directory's permissions and free space.", 500)
	}
	c.settings = next
	c.lastError = ""
	c.startLocked(listener, config)
	return c.statusLocked(), nil
}

func (c *Controller) startLocked(listener net.Listener, config *tls.Config) {
	ctx, cancel := context.WithCancel(c.root)
	server := &http.Server{Handler: c.handler(net.JoinHostPort(c.settings.Address, strconv.Itoa(c.settings.Port))), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 1 << 20, BaseContext: func(net.Listener) context.Context { return ctx }}
	live := &runtime{server: server, cancel: cancel, listener: listener}
	c.live = live
	go func() {
		err := server.Serve(tls.NewListener(listener, config))
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.live != live {
			return
		}
		cancel()
		server.Close()
		c.live = nil
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			c.lastError = "The peer endpoint stopped unexpectedly. Disable access, then enable it again."
		}
	}()
}

func (c *Controller) Disable() (Status, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	next := c.settings
	next.Enabled = false
	if err := c.write(c.path, next); err != nil {
		return c.statusLocked(), failure("save_failed", "Could not save disabled access. The endpoint was left unchanged; check permissions and free space.", 500)
	}
	c.stopLocked()
	c.settings = next
	c.loadFailed = false
	c.lastError = ""
	return c.statusLocked(), nil
}
func (c *Controller) stopLocked() {
	if c.live != nil {
		live := c.live
		c.live = nil
		live.cancel()
		live.listener.Close()
		live.server.Close()
	}
}
func (c *Controller) Close() { c.mu.Lock(); defer c.mu.Unlock(); c.closed = true; c.stopLocked() }

// NetworkBound reports whether a separately configured primary listener may
// still accept peers after this listener is disabled.
func NetworkBound(host string) bool {
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip == nil || !ip.IsLoopback()
}
