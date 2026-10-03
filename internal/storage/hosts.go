package storage

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

type PeerGrant struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Access    string    `json:"access"`
	CreatedAt time.Time `json:"created_at"`
	tokenHash []byte
}

func randomID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func (s *Store) migrateHosts() error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS peer_grants(id TEXT PRIMARY KEY, name TEXT NOT NULL, access TEXT NOT NULL CHECK(access IN ('read','control')), created_at TEXT NOT NULL, token_hash BLOB NOT NULL UNIQUE);`); err != nil {
		return err
	}
	if _, err = tx.Exec(`CREATE TABLE IF NOT EXISTS host_connections(id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, controller_id TEXT NOT NULL UNIQUE, token TEXT NOT NULL, ca_pem TEXT NOT NULL, access TEXT NOT NULL CHECK(access IN ('read','control')))`); err != nil {
		return err
	}
	id, err := randomID()
	if err != nil {
		return err
	}
	if _, err = tx.Exec("INSERT INTO metadata(key,value) VALUES('controller_id',?) ON CONFLICT(key) DO NOTHING", id); err != nil {
		return err
	}
	return tx.Commit()
}

// HostConnection contains recoverable outbound credentials for the private
// database only. It must never be used as an API response.
type HostConnection struct {
	ID, Name, URL, ControllerID, Token, CAPEM, Access string
}

func (s *Store) Hosts() ([]HostConnection, error) {
	rows, err := s.DB.Query("SELECT id,name,url,controller_id,token,ca_pem,access FROM host_connections ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	hosts := []HostConnection{}
	for rows.Next() {
		var h HostConnection
		if err := rows.Scan(&h.ID, &h.Name, &h.URL, &h.ControllerID, &h.Token, &h.CAPEM, &h.Access); err != nil {
			return nil, err
		}
		hosts = append(hosts, h)
	}
	return hosts, rows.Err()
}

func (s *Store) SaveHost(h HostConnection) error {
	if h.ID == "" || strings.TrimSpace(h.Name) == "" || h.URL == "" || h.ControllerID == "" || h.Token == "" {
		return fmt.Errorf("host connection is incomplete")
	}
	_, err := s.DB.Exec(`INSERT INTO host_connections(id,name,url,controller_id,token,ca_pem,access) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,url=excluded.url,controller_id=excluded.controller_id,token=excluded.token,ca_pem=excluded.ca_pem,access=excluded.access`, h.ID, h.Name, h.URL, h.ControllerID, h.Token, h.CAPEM, h.Access)
	return err
}

func (s *Store) DeleteHost(id string) error {
	_, err := s.DB.Exec("DELETE FROM host_connections WHERE id=?", id)
	return err
}

func (s *Store) ControllerID() (string, error) {
	var id string
	err := s.DB.QueryRow("SELECT value FROM metadata WHERE key='controller_id'").Scan(&id)
	if err == nil && id == "" {
		err = fmt.Errorf("controller identity is empty")
	}
	return id, err
}

func (s *Store) IssuePeerGrant(name, access string) (PeerGrant, string, error) {
	var grant PeerGrant
	name = strings.TrimSpace(name)
	if name == "" || (access != "read" && access != "control") {
		return grant, "", fmt.Errorf("grant requires a name and read or control access")
	}
	id, err := randomID()
	if err != nil {
		return grant, "", err
	}
	b := make([]byte, 32)
	if _, err = rand.Read(b); err != nil {
		return grant, "", err
	}
	token := base64.RawURLEncoding.EncodeToString(b)
	hash := sha256.Sum256([]byte(token))
	grant = PeerGrant{ID: id, Name: name, Access: access, CreatedAt: time.Now().UTC(), tokenHash: hash[:]}
	_, err = s.DB.Exec("INSERT INTO peer_grants(id,name,access,created_at,token_hash) VALUES(?,?,?,?,?)", grant.ID, grant.Name, grant.Access, grant.CreatedAt.Format(time.RFC3339Nano), grant.tokenHash)
	if err != nil {
		return PeerGrant{}, "", err
	}
	return grant, token, nil
}

func scanPeerGrant(row interface{ Scan(...any) error }) (PeerGrant, error) {
	var grant PeerGrant
	var created string
	if err := row.Scan(&grant.ID, &grant.Name, &grant.Access, &created); err != nil {
		return grant, err
	}
	var err error
	grant.CreatedAt, err = time.Parse(time.RFC3339Nano, created)
	return grant, err
}

func (s *Store) PeerGrants() ([]PeerGrant, error) {
	rows, err := s.DB.Query("SELECT id,name,access,created_at FROM peer_grants ORDER BY created_at,id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	grants := []PeerGrant{}
	for rows.Next() {
		grant, err := scanPeerGrant(rows)
		if err != nil {
			return nil, err
		}
		grants = append(grants, grant)
	}
	return grants, rows.Err()
}

func (s *Store) AuthenticatePeer(token string) (PeerGrant, bool, error) {
	if token == "" {
		return PeerGrant{}, false, nil
	}
	hash := sha256.Sum256([]byte(token))
	grant, err := scanPeerGrant(s.DB.QueryRow("SELECT id,name,access,created_at FROM peer_grants WHERE token_hash=?", hash[:]))
	if err == sql.ErrNoRows {
		return PeerGrant{}, false, nil
	}
	return grant, err == nil, err
}

func (s *Store) RevokePeerGrant(id string) error {
	_, err := s.DB.Exec("DELETE FROM peer_grants WHERE id=?", id)
	return err
}
