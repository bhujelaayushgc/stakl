package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/bhujelaayushgc/stakl/internal/api"
)

func runTLS(dir string, args []string) error {
	if len(args) != 3 || args[0] != "init" || args[1] != "--host" || !validTLSHost(args[2]) {
		return fmt.Errorf("usage: stakl tls init --host HOST (DNS name or IP address)")
	}
	host := args[2]
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return err
	}
	now := time.Now()
	cert := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: host}, NotBefore: now.Add(-5 * time.Minute), NotAfter: now.AddDate(1, 0, 0),
		DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
		BasicConstraintsValid: true, IsCA: true, KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	if ip := net.ParseIP(host); ip != nil {
		cert.IPAddresses = append(cert.IPAddresses, ip)
	} else if host != "localhost" {
		cert.DNSNames = append(cert.DNSNames, host)
	}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	if err != nil {
		return err
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	certFile, keyFile := filepath.Join(dir, "tls-cert.pem"), filepath.Join(dir, "tls-key.pem")
	// Exclusive creation preserves existing material, including partial pairs and symlinks.
	keyOut, err := os.OpenFile(keyFile, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return fmt.Errorf("create TLS private key (existing files are preserved): %w", err)
	}
	complete := false
	defer func() {
		keyOut.Close()
		if !complete {
			os.Remove(keyFile)
		}
	}()
	certOut, err := os.OpenFile(certFile, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return fmt.Errorf("create TLS certificate (existing files are preserved): %w", err)
	}
	defer func() {
		certOut.Close()
		if !complete {
			os.Remove(certFile)
		}
	}()
	if err := pem.Encode(keyOut, &pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}); err != nil {
		return err
	}
	if err := keyOut.Close(); err != nil {
		return err
	}
	if err := pem.Encode(certOut, &pem.Block{Type: "CERTIFICATE", Bytes: der}); err != nil {
		return err
	}
	if err := certOut.Close(); err != nil {
		return err
	}
	complete = true
	fmt.Printf("Public certificate: %s\nPrivate key: %s\n\nAdd to the server section of your configuration:\n  tls_cert_file: tls-cert.pem\n  tls_key_file: tls-key.pem\n\nRestart Stakl with --no-browser for headless HTTPS. Remote binding also requires server.token with at least 32 characters.\nTransfer only the public certificate %s as the trusted PEM when registering this peer. Keep the private key on this machine and back it up separately.\n", certFile, keyFile, certFile)
	return nil
}

func validTLSHost(host string) bool {
	if ip := net.ParseIP(host); ip != nil {
		return !ip.IsUnspecified()
	}
	if len(host) == 0 || len(host) > 253 {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, c := range label {
			if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-') {
				return false
			}
		}
	}
	return true
}

// Select a certificate identity independently of the literal local listener address.
// DNS identities are never resolved to choose the CLI's dial target.
func tlsClientServerName(cert *x509.Certificate, host string) (string, error) {
	if cert.VerifyHostname(host) == nil {
		return host, nil
	}
	for _, name := range cert.DNSNames {
		if strings.HasPrefix(name, "*.") {
			name = "stakl." + strings.TrimPrefix(name, "*.")
		}
		if validTLSHost(name) && cert.VerifyHostname(name) == nil {
			return name, nil
		}
	}
	for _, ip := range cert.IPAddresses {
		if cert.VerifyHostname(ip.String()) == nil {
			return ip.String(), nil
		}
	}
	return "", fmt.Errorf("server TLS certificate requires a DNS or IP SAN for local CLI verification")
}

func instanceClient(ctx context.Context, inst instance, method, path string, body io.Reader) (*http.Response, error) {
	var ca []byte
	if inst.CAFile != "" {
		var err error
		ca, err = os.ReadFile(inst.CAFile)
		if err != nil {
			return nil, fmt.Errorf("read local TLS trust: %w", err)
		}
		if len(ca) == 0 {
			return nil, fmt.Errorf("local TLS trust file is empty")
		}
	}
	if inst.TLSServerName != "" {
		return api.LocalClientWithCA(ctx, inst.URL, inst.Token, method, path, body, ca, inst.TLSServerName)
	}
	return api.ClientWithCA(ctx, inst.URL, inst.Token, method, path, body, ca)
}
