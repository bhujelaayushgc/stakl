package api

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTLSLoadsValidPairAndRejectsInvalidMaterial(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	certFile, keyFile := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	if err := os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}), 0600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name                string
		notBefore, notAfter time.Time
		usage               x509.ExtKeyUsage
		wantErr             bool
	}{
		{"valid", time.Now().Add(-time.Hour), time.Now().Add(time.Hour), x509.ExtKeyUsageServerAuth, false},
		{"expired", time.Now().Add(-2 * time.Hour), time.Now().Add(-time.Hour), x509.ExtKeyUsageServerAuth, true},
		{"future", time.Now().Add(time.Hour), time.Now().Add(2 * time.Hour), x509.ExtKeyUsageServerAuth, true},
		{"client-only", time.Now().Add(-time.Hour), time.Now().Add(time.Hour), x509.ExtKeyUsageClientAuth, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			template := &x509.Certificate{SerialNumber: big.NewInt(1), DNSNames: []string{"localhost"}, NotBefore: tc.notBefore, NotAfter: tc.notAfter, ExtKeyUsage: []x509.ExtKeyUsage{tc.usage}}
			der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600); err != nil {
				t.Fatal(err)
			}
			cfg, cert, err := LoadTLS(certFile, keyFile)
			if tc.wantErr {
				if err == nil {
					t.Fatal("invalid certificate accepted")
				}
			} else if err != nil || cfg == nil || cert == nil || cert.VerifyHostname("localhost") != nil {
				t.Fatalf("valid pair: %v", err)
			}
		})
	}
	if _, _, err := LoadTLS(certFile, filepath.Join(dir, "missing.pem")); err == nil {
		t.Fatal("missing key accepted")
	}
	os.WriteFile(certFile, []byte("invalid"), 0600)
	if _, _, err := LoadTLS(certFile, keyFile); err == nil {
		t.Fatal("invalid certificate PEM accepted")
	}
}

func TestHTTPSClientRefusesRedirects(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("credential-bearing redirect followed") }))
	defer target.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 307) }))
	defer origin.Close()
	response, err := ClientWithCA(t.Context(), origin.URL, "secret", "POST", "/", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 307 {
		t.Fatal(response.Status)
	}
}

func TestHTTPSAuthenticationAndHost(t *testing.T) {
	s, _ := peerFixture(t)
	s.Certificate = &x509.Certificate{DNSNames: []string{"peer.example", "localhost"}, IPAddresses: []net.IP{net.ParseIP("192.0.2.42")}}
	s.BindHost = "127.0.0.1"
	h := s.Handler()
	for _, tc := range []struct {
		host, origin string
		want         int
	}{
		{"peer.example:49152", "https://peer.example:49152", 200},
		{"localhost:49152", "https://localhost:49152", 200},
		{"192.0.2.42:49152", "https://192.0.2.42:49152", 200},
		{"192.0.2.43:49152", "", 403},
		{"peer.example:49153", "", 403},
		{"evil.example:49152", "", 403},
		{"peer.example:49152", "http://peer.example:49152", 403},
	} {
		r := httptest.NewRequest("GET", "https://"+tc.host+"/api/apps", nil)
		r.Header.Set("Authorization", "Bearer admin")
		r.Header.Set("Origin", tc.origin)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Errorf("host %s origin %s: %d, want %d", tc.host, tc.origin, w.Code, tc.want)
		}
	}
	r := httptest.NewRequest("GET", "https://127.0.0.1:49152/?token=admin", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].Secure {
		t.Fatal("HTTPS auth cookie is not Secure")
	}
	r = httptest.NewRequest("GET", "http://127.0.0.1:49152/api/apps", nil)
	r.Header.Set("Authorization", "Bearer admin")
	r.Header.Set("Origin", "https://127.0.0.1:49152")
	r.Header.Set("X-Forwarded-Proto", "https")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("forwarded scheme was trusted")
	}
}

func TestHTTPSClientTrustAndSAN(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer secret" {
			t.Error("missing bearer credential")
		}
		w.WriteHeader(204)
	}))
	defer server.Close()
	ca := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw})
	response, err := ClientWithCA(t.Context(), server.URL, "secret", "GET", "/", nil, ca)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 204 {
		t.Fatal(response.Status)
	}
	if _, err = Client(t.Context(), server.URL, "secret", "GET", "/", nil); err == nil {
		t.Fatal("untrusted certificate accepted")
	}
	if _, err = ClientWithCA(t.Context(), server.URL, "secret", "GET", "/", nil, []byte("invalid")); err == nil {
		t.Fatal("invalid trust accepted")
	}
	// A trusted chain still requires an IP SAN for the actual connection host.
	badURL := strings.Replace(server.URL, "127.0.0.1", "localhost", 1)
	if _, err = ClientWithCA(t.Context(), badURL, "secret", "GET", "/", nil, ca); err == nil {
		t.Fatal("SAN mismatch accepted")
	}
}
