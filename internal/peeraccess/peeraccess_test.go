package peeraccess

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bhujelaayushgc/stakl/internal/supervisor"
	"github.com/bhujelaayushgc/stakl/internal/tlsutil"
)

func fixture(t *testing.T, path string, handler http.Handler) *Controller {
	t.Helper()
	c := New(path, func(string) http.Handler { return handler })
	c.addresses = func() ([]string, error) { return []string{"127.0.0.1"}, nil }
	t.Cleanup(c.Close)
	return c
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func trustedClient(t *testing.T, status Status) *http.Client {
	t.Helper()
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM([]byte(status.CAPEM)) {
		t.Fatal("no public certificate")
	}
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots}}, Timeout: 3 * time.Second}
	t.Cleanup(client.CloseIdleConnections)
	return client
}

func TestEnablePersistsTrustedEndpointAndDisableCancelsRequests(t *testing.T) {
	started, cancelled := make(chan struct{}), make(chan struct{})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/stream" {
			close(started)
			w.Write([]byte("stream\n"))
			w.(http.Flusher).Flush()
			<-r.Context().Done()
			close(cancelled)
			return
		}
		io.WriteString(w, "peer")
	})
	path := filepath.Join(t.TempDir(), "peer-access.json")
	c := fixture(t, path, handler)
	status, err := c.Enable(context.Background(), EnableRequest{Address: "127.0.0.1", Port: freePort(t)})
	if err != nil {
		t.Fatal(err)
	}
	if !status.Enabled || !status.Running || !strings.HasPrefix(status.Endpoint, "https://127.0.0.1:") {
		t.Fatalf("bad status: %+v", status)
	}
	st, err := os.Stat(path)
	if err != nil || st.Mode().Perm() != 0600 {
		t.Fatalf("private permissions: %v %v", st, err)
	}
	b, _ := json.Marshal(status)
	if strings.Contains(string(b), "PRIVATE KEY") || strings.Contains(string(b), "private_key") {
		t.Fatal("status leaked key")
	}
	client := trustedClient(t, status)
	resp, err := client.Get(status.Endpoint)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("endpoint: %d", resp.StatusCode)
	}
	resp, err = client.Get(status.Endpoint + "/stream")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	<-started
	if _, err := c.Disable(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("disable did not cancel stream")
	}
	if c.Status().Enabled || c.Status().Running {
		t.Fatal("still enabled")
	}
	if _, err := client.Get(status.Endpoint); err == nil {
		t.Fatal("disabled endpoint accepts requests")
	}
	if _, err := c.Disable(); err != nil {
		t.Fatal(err)
	}
	next, err := c.Enable(context.Background(), EnableRequest{Address: status.Address, Port: status.Port})
	if err != nil || next.CAPEM != status.CAPEM {
		t.Fatalf("re-enable changed certificate: %v", err)
	}
	c.Close()
	restored := fixture(t, path, handler)
	restored.Restore(context.Background())
	if next := restored.Status(); !next.Running || next.CAPEM != status.CAPEM {
		t.Fatalf("restore failed: %+v", next)
	}
}

func TestFailuresPreserveSettingsAndReleasePreparedPort(t *testing.T) {
	c := fixture(t, filepath.Join(t.TempDir(), "peer-access.json"), http.NotFoundHandler())
	port := freePort(t)
	occupied, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Enable(context.Background(), EnableRequest{Address: "127.0.0.1", Port: port}); err == nil {
		t.Fatal("accepted occupied port")
	}
	occupied.Close()
	c.write = func(string, any) error { return fmt.Errorf("disk full") }
	if _, err := c.Enable(context.Background(), EnableRequest{Address: "127.0.0.1", Port: port}); err == nil {
		t.Fatal("accepted failed persistence")
	}
	l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatal("prepared socket leaked:", err)
	}
	l.Close()
	if c.Status().Enabled || c.Status().HasCertificate {
		t.Fatal("failed enable changed settings")
	}
	c.write = supervisor.AtomicJSON
	status, err := c.Enable(context.Background(), EnableRequest{Address: "127.0.0.1", Port: port})
	if err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(c.path)
	c.write = func(string, any) error { return fmt.Errorf("disk full") }
	if _, err := c.Disable(); err == nil || !c.Status().Running {
		t.Fatal("failed save closed live endpoint")
	}
	after, _ := os.ReadFile(c.path)
	if string(before) != string(after) || c.Status().CAPEM != status.CAPEM {
		t.Fatal("failed operation changed saved state")
	}
	if _, err := c.Enable(context.Background(), EnableRequest{Address: "127.0.0.1", Port: freePort(t)}); err == nil {
		t.Fatal("changed running listener")
	}
}

func TestRestoreFailureRequiresExplicitCertificateReplacement(t *testing.T) {
	path := filepath.Join(t.TempDir(), "peer-access.json")
	cert, key, err := tlsutil.Generate([]string{"192.0.2.5"})
	if err != nil {
		t.Fatal(err)
	}
	// Alter the saved address to one not covered by the generated certificate.
	data := map[string]any{"enabled": true, "address": "192.0.2.6", "port": freePort(t), "certificate_pem": string(cert), "private_key_pem": string(key)}
	if err := supervisor.AtomicJSON(path, data); err != nil {
		t.Fatal(err)
	}
	c := fixture(t, path, http.NotFoundHandler())
	c.addresses = func() ([]string, error) { return []string{"192.0.2.6", "127.0.0.1"}, nil }
	c.Restore(context.Background())
	if status := c.Status(); !status.Enabled || status.Running || status.Error == "" {
		t.Fatalf("failure hidden: %+v", status)
	}
	before, _ := os.ReadFile(path)
	if _, err := c.Enable(context.Background(), EnableRequest{Address: "192.0.2.6", Port: freePort(t)}); err == nil {
		t.Fatal("silently replaced mismatched certificate")
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatal("restore replaced saved settings")
	}
	if _, err := c.Enable(context.Background(), EnableRequest{Address: "127.0.0.1", Port: freePort(t), ReplaceCertificate: true}); err != nil {
		t.Fatal(err)
	}
}

func TestAddressValidationAndConcurrentActions(t *testing.T) {
	for _, address := range []string{"0.0.0.0", "::", "127.0.0.1", "::1", "169.254.1.2", "fe80::1", "ff02::1", "224.0.0.1", "fe80::1%en0", "example.com", ""} {
		if usableAddress(address) {
			t.Fatalf("offered unsuitable address %q", address)
		}
	}
	for _, address := range []string{"192.168.1.10", "10.0.0.5", "2001:db8::1"} {
		if !usableAddress(address) {
			t.Fatalf("rejected %q", address)
		}
	}
	c := fixture(t, filepath.Join(t.TempDir(), "peer-access.json"), http.NotFoundHandler())
	for _, request := range []EnableRequest{{Address: "192.0.2.8", Port: 49153}, {Address: "127.0.0.1", Port: 0}, {Address: "127.0.0.1", Port: 65536}} {
		if _, err := c.Enable(context.Background(), request); err == nil {
			t.Fatalf("accepted invalid request %+v", request)
		}
	}
	request := EnableRequest{Address: "127.0.0.1", Port: freePort(t)}
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := c.Enable(context.Background(), request); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := c.Disable(); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
}

func TestExpiredCertificateAndFailedStartupNeverRotateTrust(t *testing.T) {
	path := filepath.Join(t.TempDir(), "peer-access.json")
	certPEM, keyPEM, err := tlsutil.Generate([]string{"127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	cert.NotBefore = time.Now().Add(-365 * 24 * time.Hour)
	cert.NotAfter = time.Now().Add(-time.Hour)
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, cert.PublicKey, pair.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	saved := settings{Enabled: true, Address: "127.0.0.1", Port: freePort(t), CertificatePEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), PrivateKeyPEM: string(keyPEM)}
	if err := supervisor.AtomicJSON(path, saved); err != nil {
		t.Fatal(err)
	}
	c := fixture(t, path, http.NotFoundHandler())
	c.Restore(context.Background())
	if status := c.Status(); status.Running || !status.Enabled || status.Error == "" {
		t.Fatalf("invalid expiry accepted: %+v", status)
	}
	if _, err := c.Enable(context.Background(), EnableRequest{Address: saved.Address, Port: saved.Port}); err == nil {
		t.Fatal("silently replaced expired certificate")
	}
	if status, err := c.Enable(context.Background(), EnableRequest{Address: saved.Address, Port: saved.Port, ReplaceCertificate: true}); err != nil || status.CAPEM == saved.CertificatePEM {
		t.Fatalf("explicit replacement failed: %v", err)
	}
	c.Close()
	occupied, err := net.Listen("tcp", net.JoinHostPort(saved.Address, fmt.Sprint(saved.Port)))
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	before, _ := os.ReadFile(path)
	restored := fixture(t, path, http.NotFoundHandler())
	restored.Restore(context.Background())
	if status := restored.Status(); status.Running || !status.Enabled || status.Error == "" {
		t.Fatal("occupied startup port was not reported")
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatal("startup failure changed certificate/settings")
	}
}

func TestDamagedSettingsRecoverOnlyOnExplicitDisable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "peer-access.json")
	if err := os.WriteFile(path, []byte(`{"private_key_pem":"TOP SECRET"`), 0600); err != nil {
		t.Fatal(err)
	}
	c := fixture(t, path, http.NotFoundHandler())
	c.Restore(context.Background())
	status := c.Status()
	b, _ := json.Marshal(status)
	if status.Error == "" || strings.Contains(string(b), "TOP SECRET") {
		t.Fatal("damaged settings were hidden or leaked")
	}
	if _, err := c.Enable(context.Background(), EnableRequest{Address: "127.0.0.1", Port: freePort(t)}); err == nil {
		t.Fatal("silently reset damaged settings")
	}
	if _, err := c.Disable(); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Enable(context.Background(), EnableRequest{Address: "127.0.0.1", Port: freePort(t)}); err != nil {
		t.Fatal(err)
	}
}

func TestLiveEndpointReportsAddressLossAndCertificateExpiry(t *testing.T) {
	c := fixture(t, filepath.Join(t.TempDir(), "peer-access.json"), http.NotFoundHandler())
	certPEM, keyPEM, err := tlsutil.Generate([]string{"127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	cert.NotAfter = time.Now().Add(3 * time.Second).Truncate(time.Second)
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, cert.PublicKey, pair.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	c.settings.CertificatePEM = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	c.settings.PrivateKeyPEM = string(keyPEM)
	if _, err := c.Enable(context.Background(), EnableRequest{Address: "127.0.0.1", Port: freePort(t)}); err != nil {
		t.Fatal(err)
	}
	c.addresses = func() ([]string, error) { return []string{}, nil }
	if status := c.Status(); !status.Running || !strings.Contains(status.Error, "address") {
		t.Fatalf("address loss hidden: %+v", status)
	}
	c.addresses = func() ([]string, error) { return []string{"127.0.0.1"}, nil }
	if err := c.Status().Error; err != "" {
		t.Fatalf("recovered address still unhealthy: %s", err)
	}
	time.Sleep(time.Until(cert.NotAfter) + 10*time.Millisecond)
	if status := c.Status(); !status.Running || !strings.Contains(status.Error, "certificate") {
		t.Fatalf("expiry hidden: %+v", status)
	}
}
