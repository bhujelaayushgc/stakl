package supervisor

import (
	"bytes"
	"encoding/json"
	"fmt"
	"github.com/bhujelaayushgc/stakl/internal/config"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type Log struct {
	Seq    int64     `json:"seq"`
	Time   time.Time `json:"time"`
	App    string    `json:"app"`
	Launch string    `json:"launch"`
	Stream string    `json:"stream"`
	Text   string    `json:"text"`
}
type logWriter struct {
	mu                sync.Mutex
	path, app, launch string
	policy            config.Logging
	seq               int64
}

func (w *logWriter) write(stream, line string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.seq++
	l := Log{w.seq, time.Now().UTC(), w.app, w.launch, stream, line}
	b, _ := json.Marshal(l)
	b = append(b, '\n')
	if s, e := os.Stat(w.path); e == nil && s.Size()+int64(len(b)) > int64(w.policy.MaxSizeMB)*1024*1024 {
		os.Remove(fmt.Sprintf("%s.%d", w.path, w.policy.MaxFiles))
		for i := w.policy.MaxFiles - 1; i >= 1; i-- {
			os.Rename(fmt.Sprintf("%s.%d", w.path, i), fmt.Sprintf("%s.%d", w.path, i+1))
		}
		os.Rename(w.path, w.path+".1")
	}
	f, e := os.OpenFile(w.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if e == nil {
		_, _ = f.Write(b)
		f.Close()
	}
	matches, _ := filepath.Glob(w.path + ".*")
	for _, p := range matches {
		if s, e := os.Stat(p); e == nil && time.Since(s.ModTime()) > time.Duration(w.policy.RetentionDays)*24*time.Hour {
			os.Remove(p)
		}
	}
}

type streamWriter struct {
	w       *logWriter
	stream  string
	pending []byte
}

func (s *streamWriter) Write(p []byte) (int, error) {
	n := len(p)
	for _, b := range p {
		if b == '\n' {
			s.w.write(s.stream, string(s.pending))
			s.pending = nil
		} else {
			s.pending = append(s.pending, b)
			if len(s.pending) >= 64*1024 {
				s.w.write(s.stream, string(s.pending))
				s.pending = nil
			}
		}
	}
	return n, nil
}
func (s *streamWriter) flush() {
	if len(s.pending) > 0 {
		s.w.write(s.stream, string(s.pending))
		s.pending = nil
	}
}

// Read only enough bytes from the end of each file to satisfy the requested tail.
func tail(path string, limit int) []Log {
	f, e := os.Open(path)
	if e != nil {
		return nil
	}
	defer f.Close()
	st, e := f.Stat()
	if e != nil {
		return nil
	}
	pos := st.Size()
	data := []byte{}
	lines := 0
	for pos > 0 && lines <= limit {
		size := int64(64 * 1024)
		if pos < size {
			size = pos
		}
		pos -= size
		chunk := make([]byte, size)
		n, e := f.ReadAt(chunk, pos)
		if e != nil && e != io.EOF {
			return nil
		}
		chunk = chunk[:n]
		lines += bytes.Count(chunk, []byte{'\n'})
		data = append(chunk, data...)
	}
	records := bytes.Split(data, []byte{'\n'})
	if pos > 0 && len(records) > 0 {
		records = records[1:]
	}
	out := []Log{}
	for _, record := range records {
		var l Log
		if json.Unmarshal(record, &l) == nil {
			out = append(out, l)
		}
	}
	if len(out) > limit {
		out = out[len(out)-limit:]
	}
	return out
}
func ReadLogs(path string, maxFiles, limit int, after int64) []Log {
	out := []Log{}
	for i := 0; i <= maxFiles && len(out) < limit; i++ {
		p := path
		if i > 0 {
			p = fmt.Sprintf("%s.%d", path, i)
		}
		rows := tail(p, limit-len(out))
		out = append(rows, out...)
	}
	filtered := []Log{}
	for _, l := range out {
		if l.Seq > after {
			filtered = append(filtered, l)
		}
	}
	return filtered
}
