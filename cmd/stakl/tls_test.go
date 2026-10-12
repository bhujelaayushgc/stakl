package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/x509"
	"encoding/pem"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTLSLocalIdentitySelection(t *testing.T) {
	for _, tc := range []struct {
		cert       *x509.Certificate
		host, want string
		fail       bool
	}{
		{&x509.Certificate{IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}}, "127.0.0.1", "127.0.0.1", false},
		{&x509.Certificate{DNSNames: []string{"localhost"}}, "127.0.0.1", "localhost", false},
		{&x509.Certificate{IPAddresses: []net.IP{net.ParseIP("::1")}}, "::1", "::1", false},
		{&x509.Certificate{DNSNames: []string{"peer.example"}}, "127.0.0.1", "peer.example", false},
		{&x509.Certificate{DNSNames: []string{"*.example.com"}}, "127.0.0.1", "stakl.example.com", false},
		{&x509.Certificate{IPAddresses: []net.IP{net.ParseIP("192.0.2.42")}}, "127.0.0.1", "192.0.2.42", false},
		{&x509.Certificate{}, "127.0.0.1", "", true},
	} {
		host, err := tlsClientServerName(tc.cert, tc.host)
		if tc.fail {
			if err == nil || !strings.Contains(err.Error(), "SAN") {
				t.Fatalf("missing certificate SAN accepted: %s %v", host, err)
			}
		} else if err != nil || host != tc.want {
			t.Fatalf("verified TLS identity: %s %v", host, err)
		}
	}
}

func TestTLSInitPreservesFiles(t *testing.T) {
	for _, host := range []string{"peer.example", "192.0.2.42"} {
		t.Run(host, func(t *testing.T) {
			dir := t.TempDir()
			output, err := captureCLI(func() error { return runTLS(dir, []string{"init", "--host", host}) })
			if err != nil {
				t.Fatal(err)
			}
			certFile, keyFile := filepath.Join(dir, "tls-cert.pem"), filepath.Join(dir, "tls-key.pem")
			certPEM, err := os.ReadFile(certFile)
			if err != nil {
				t.Fatal(err)
			}
			block, _ := pem.Decode(certPEM)
			if block == nil {
				t.Fatal("invalid PEM")
			}
			cert, err := x509.ParseCertificate(block.Bytes)
			if err != nil {
				t.Fatal(err)
			}
			for _, san := range []string{"localhost", "127.0.0.1", "::1", host} {
				if err := cert.VerifyHostname(san); err != nil {
					t.Fatal(err)
				}
			}
			if cert.NotAfter.Sub(cert.NotBefore) < 364*24*time.Hour || cert.NotAfter.Sub(cert.NotBefore) > 367*24*time.Hour {
				t.Fatal("certificate is not valid for one year")
			}
			if err := cert.CheckSignatureFrom(cert); err != nil {
				t.Fatal(err)
			}
			public, ok := cert.PublicKey.(*ecdsa.PublicKey)
			if !ok || public.Curve != elliptic.P256() {
				t.Fatal("certificate is not ECDSA P-256")
			}
			keyBefore, err := os.ReadFile(keyFile)
			if err != nil {
				t.Fatal(err)
			}
			for _, file := range []string{certFile, keyFile} {
				st, err := os.Stat(file)
				if err != nil || st.Mode().Perm() != 0600 {
					t.Fatalf("private permissions: %s %v", file, err)
				}
			}
			if !strings.Contains(output, certFile) || !strings.Contains(output, "tls_cert_file") || !strings.Contains(output, "public certificate") || strings.Contains(output, "PRIVATE KEY") {
				t.Fatalf("setup instructions: %s", output)
			}
			if err := runTLS(dir, []string{"init", "--host", host}); err == nil {
				t.Fatal("second init succeeded")
			}
			keyAfter, _ := os.ReadFile(keyFile)
			if !bytes.Equal(keyBefore, keyAfter) {
				t.Fatal("tls init overwrote key")
			}
			certAfter, _ := os.ReadFile(certFile)
			if !bytes.Equal(certPEM, certAfter) {
				t.Fatal("tls init overwrote certificate")
			}
		})
	}
	for _, args := range [][]string{{"init"}, {"init", "--host", "https://peer.example"}, {"init", "--host", ""}, {"init", "--host", "peer.example", "--bad"}} {
		if err := runTLS(t.TempDir(), args); err == nil {
			t.Fatalf("accepted invalid arguments %v", args)
		}
	}
	dir := t.TempDir()
	keyFile := filepath.Join(dir, "tls-key.pem")
	os.WriteFile(keyFile, []byte("existing"), 0600)
	if err := runTLS(dir, []string{"init", "--host", "peer.example"}); err == nil {
		t.Fatal("overwrote partial pair")
	}
	if _, err := os.Stat(filepath.Join(dir, "tls-cert.pem")); !os.IsNotExist(err) {
		t.Fatal("left partial certificate")
	}
}
