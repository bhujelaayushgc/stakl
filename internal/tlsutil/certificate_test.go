package tlsutil

import (
	"crypto/ecdsa"
	"crypto/tls"
	"crypto/x509"
	"testing"
	"time"
)

func TestGeneratedCertificateTrustsSelectedAddresses(t *testing.T) {
	certPEM, keyPEM, err := Generate([]string{"192.0.2.10", "2001:db8::10", "peer.example"})
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
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(certPEM) {
		t.Fatal("invalid public certificate")
	}
	for _, host := range []string{"192.0.2.10", "2001:db8::10", "peer.example", "localhost", "127.0.0.1", "::1"} {
		if _, err := cert.Verify(x509.VerifyOptions{Roots: roots, DNSName: host}); err != nil {
			t.Fatalf("%s: %v", host, err)
		}
	}
	if err := cert.VerifyHostname("192.0.2.11"); err == nil {
		t.Fatal("trusted an address outside the SANs")
	}
	if key, ok := pair.PrivateKey.(*ecdsa.PrivateKey); !ok || key.Curve.Params().BitSize != 256 {
		t.Fatal("expected ECDSA P-256")
	}
	if remaining := time.Until(cert.NotAfter); remaining < 364*24*time.Hour || remaining > 367*24*time.Hour {
		t.Fatalf("unexpected expiry: %v", remaining)
	}
}

func TestGeneratedCertificateRequiresIdentity(t *testing.T) {
	for _, hosts := range [][]string{nil, {""}} {
		if _, _, err := Generate(hosts); err == nil {
			t.Fatal("accepted missing identity")
		}
	}
}
