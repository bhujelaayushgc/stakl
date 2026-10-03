package storage

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestControllerIdentityPersists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	id, err := s.ControllerID()
	if err != nil || id == "" {
		t.Fatalf("identity: %q %v", id, err)
	}
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			got, err := s.ControllerID()
			if err != nil || got != id {
				t.Errorf("concurrent identity: %q %v", got, err)
			}
		})
	}
	wg.Wait()
	s.DB.Close()
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.DB.Close()
	reopened, err := s.ControllerID()
	if err != nil || reopened != id {
		t.Fatalf("controller identity changed: %q %v", reopened, err)
	}
	other, err := Open(filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer other.DB.Close()
	otherID, err := other.ControllerID()
	if err != nil || otherID == id {
		t.Fatalf("state directories share identity: %q %v", otherID, err)
	}
}

func TestPeerGrantsStoreOnlyDigests(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	grant, token, err := s.IssuePeerGrant("test", "read")
	if err != nil || token == "" || grant.ID == "" || grant.CreatedAt.IsZero() {
		t.Fatalf("issue: %+v %q %v", grant, token, err)
	}
	var storedHash []byte
	if err := s.DB.QueryRow("SELECT token_hash FROM peer_grants WHERE id=?", grant.ID).Scan(&storedHash); err != nil {
		t.Fatal(err)
	}
	wantHash := sha256.Sum256([]byte(token))
	if !bytes.Equal(storedHash, wantHash[:]) {
		t.Fatal("stored credential is not its SHA-256 digest")
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		dump, err := os.ReadFile(path + suffix)
		if err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
		if bytes.Contains(dump, []byte(token)) {
			t.Fatal("issued token stored in plaintext")
		}
	}
	s.DB.Close()
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	auth, ok, err := s.AuthenticatePeer(token)
	if err != nil || !ok || auth.ID != grant.ID || auth.Access != "read" {
		t.Fatalf("auth: %+v %v %v", auth, ok, err)
	}
	for _, invalid := range []string{"", "wrong", token + "x"} {
		if _, ok, err := s.AuthenticatePeer(invalid); err != nil || ok {
			t.Fatalf("invalid authorized: %v %v", ok, err)
		}
	}
	grants, err := s.PeerGrants()
	if err != nil || len(grants) != 1 {
		t.Fatalf("list: %+v %v", grants, err)
	}
	b, err := json.Marshal(grants)
	digest := sha256.Sum256([]byte(token))
	if err != nil || bytes.Contains(b, []byte(token)) || bytes.Contains(b, []byte("hash")) || bytes.Contains(b, digest[:]) {
		t.Fatalf("list leaked credentials: %s %v", b, err)
	}
	if err := s.RevokePeerGrant(grant.ID); err != nil {
		t.Fatal(err)
	}
	s.DB.Close()
	for _, suffix := range []string{"", "-wal", "-shm"} {
		dump, err := os.ReadFile(path + suffix)
		if err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
		if bytes.Contains(dump, []byte(token)) {
			t.Fatal("issued token stored in plaintext")
		}
	}
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.DB.Close()
	if _, ok, err := s.AuthenticatePeer(token); err != nil || ok {
		t.Fatalf("revoked token survived reopen: %v %v", ok, err)
	}
	if grants, err := s.PeerGrants(); err != nil || len(grants) != 0 {
		t.Fatalf("revoked grant still listed: %+v %v", grants, err)
	}
}

func TestPeerGrantValidation(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.DB.Close()
	for _, tc := range []struct{ name, access string }{{"", "read"}, {"  ", "read"}, {"test", "admin"}, {"test", ""}} {
		if _, _, err := s.IssuePeerGrant(tc.name, tc.access); err == nil {
			t.Fatalf("accepted invalid grant %+v", tc)
		}
	}
	a, tokenA, err := s.IssuePeerGrant("test", "control")
	if err != nil {
		t.Fatal(err)
	}
	b, tokenB, err := s.IssuePeerGrant("test", "control")
	if err != nil {
		t.Fatal(err)
	}
	if a.ID == b.ID || tokenA == tokenB {
		t.Fatal("grants reused identity or credential")
	}
	if err := s.RevokePeerGrant(a.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := s.AuthenticatePeer(tokenB); err != nil || !ok {
		t.Fatalf("revocation affected another grant: %v %v", ok, err)
	}
}
