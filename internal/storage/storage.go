package storage

import (
	"database/sql"
	"encoding/json"
	"localdesk/internal/events"
	_ "modernc.org/sqlite"
	"os"
	"time"
)

type Store struct{ DB *sql.DB }

func Open(path string) (*Store, error) {
	// Set permissions before SQLite creates WAL/SHM files, which inherit the DB mode.
	file, e := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	if e = file.Chmod(0600); e != nil {
		file.Close()
		return nil, e
	}
	if e = file.Close(); e != nil {
		return nil, e
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		if e = os.Chmod(path+suffix, 0600); e != nil && !os.IsNotExist(e) {
			return nil, e
		}
	}
	db, e := sql.Open("sqlite", path)
	if e != nil {
		return nil, e
	}
	db.SetMaxOpenConns(1)
	_, e = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS runtime(app TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY, time TEXT NOT NULL, type TEXT NOT NULL, app TEXT NOT NULL, message TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS health(id INTEGER PRIMARY KEY, app TEXT NOT NULL, time TEXT NOT NULL, ok INTEGER NOT NULL, latency REAL NOT NULL, message TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS launches(id TEXT PRIMARY KEY, app TEXT NOT NULL, started TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS history_app ON history(app,id);
CREATE INDEX IF NOT EXISTS health_app ON health(app,id);`)
	if e != nil {
		db.Close()
		return nil, e
	}
	return &Store{db}, nil
}
func (s *Store) Save(id string, v any) error {
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	_, e = s.DB.Exec("INSERT INTO runtime(app,data) VALUES(?,?) ON CONFLICT(app) DO UPDATE SET data=excluded.data", id, string(b))
	return e
}
func (s *Store) Load() map[string]json.RawMessage {
	out := map[string]json.RawMessage{}
	rows, e := s.DB.Query("SELECT app,data FROM runtime")
	if e != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var id, b string
		rows.Scan(&id, &b)
		out[id] = json.RawMessage(b)
	}
	return out
}
func (s *Store) Event(e events.Event) error {
	_, err := s.DB.Exec("INSERT INTO history(time,type,app,message) VALUES(?,?,?,?)", e.Time.Format(time.RFC3339Nano), e.Type, e.App, e.Message)
	return err
}
func (s *Store) History(app string) []events.Event {
	out := []events.Event{}
	rows, e := s.DB.Query("SELECT time,type,app,message FROM history WHERE (?='' OR app=?) ORDER BY id DESC LIMIT 200", app, app)
	if e != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var e events.Event
		var t string
		rows.Scan(&t, &e.Type, &e.App, &e.Message)
		e.Time, _ = time.Parse(time.RFC3339Nano, t)
		out = append(out, e)
	}
	return out
}

type Health struct {
	Time    time.Time `json:"time"`
	OK      bool      `json:"ok"`
	Latency float64   `json:"latency"`
	Message string    `json:"message"`
}

func (s *Store) Check(app string, h Health) error {
	_, e := s.DB.Exec("INSERT INTO health(app,time,ok,latency,message) VALUES(?,?,?,?,?)", app, h.Time.Format(time.RFC3339Nano), h.OK, h.Latency, h.Message)
	return e
}
func (s *Store) Checks(app string) []Health {
	out := []Health{}
	rows, e := s.DB.Query("SELECT time,ok,latency,message FROM health WHERE app=? ORDER BY id DESC LIMIT 100", app)
	if e != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var h Health
		var t string
		rows.Scan(&t, &h.OK, &h.Latency, &h.Message)
		h.Time, _ = time.Parse(time.RFC3339Nano, t)
		out = append(out, h)
	}
	return out
}
func (s *Store) Prune(days int) error {
	cut := time.Now().Add(-time.Duration(days) * 24 * time.Hour).Format(time.RFC3339Nano)
	_, e := s.DB.Exec("DELETE FROM launches WHERE started<?; DELETE FROM history WHERE time<?; DELETE FROM health WHERE time<?; DELETE FROM health WHERE id NOT IN (SELECT id FROM health ORDER BY id DESC LIMIT 100000); DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT 50000)", cut, cut, cut)
	return e
}

func (s *Store) Launch(id, app string, started time.Time, v any) error {
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	_, e = s.DB.Exec("INSERT INTO launches(id,app,started,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", id, app, started.Format(time.RFC3339Nano), string(b))
	return e
}
func (s *Store) Launches(app string) []json.RawMessage {
	out := []json.RawMessage{}
	rows, e := s.DB.Query("SELECT data FROM launches WHERE app=? ORDER BY started DESC LIMIT 100", app)
	if e != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var b string
		rows.Scan(&b)
		out = append(out, json.RawMessage(b))
	}
	return out
}
