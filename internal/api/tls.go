package api

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"
)

// LoadTLS validates the configured key pair before the controller starts.
func LoadTLS(certFile, keyFile string) (*tls.Config, *x509.Certificate, error) {
	pair, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, nil, fmt.Errorf("load server TLS certificate/key: %w", err)
	}
	cert := pair.Leaf
	if cert == nil {
		cert, err = x509.ParseCertificate(pair.Certificate[0])
		if err != nil {
			return nil, nil, err
		}
	}
	now := time.Now()
	if now.Before(cert.NotBefore) || now.After(cert.NotAfter) {
		return nil, nil, fmt.Errorf("server TLS certificate is not currently valid")
	}
	if len(cert.ExtKeyUsage) > 0 {
		allowed := false
		for _, usage := range cert.ExtKeyUsage {
			if usage == x509.ExtKeyUsageServerAuth || usage == x509.ExtKeyUsageAny {
				allowed = true
			}
		}
		if !allowed {
			return nil, nil, fmt.Errorf("server TLS certificate does not permit server authentication")
		}
	}
	return &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{pair}}, cert, nil
}

func ClientWithCA(ctx context.Context, address, token, method, path string, body io.Reader, caPEM []byte) (*http.Response, error) {
	u, err := url.Parse(address)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String()+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Stakl", "1")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DisableKeepAlives = true
	transport.DialContext = (&net.Dialer{Timeout: 5 * time.Second}).DialContext
	transport.TLSHandshakeTimeout = 5 * time.Second
	transport.ResponseHeaderTimeout = 5 * time.Second
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	if len(caPEM) > 0 {
		roots, err := x509.SystemCertPool()
		if err != nil {
			roots = x509.NewCertPool()
		}
		if !roots.AppendCertsFromPEM(caPEM) {
			return nil, fmt.Errorf("CA PEM contains no valid certificates")
		}
		transport.TLSClientConfig.RootCAs = roots
	}
	return (&http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}).Do(req)
}
