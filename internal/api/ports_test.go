package api

import (
	"encoding/json"
	"net"
	"net/http/httptest"
	"os"
	"os/exec"
	"reflect"
	"testing"
)

func TestPortInventoryFindsLocalSockets(t *testing.T) {
	if _, err := exec.LookPath("lsof"); err != nil {
		t.Skip("lsof is not installed")
	}
	tcp, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer tcp.Close()
	udp, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer udp.Close()
	w := httptest.NewRecorder()
	(&Server{}).ports(w, httptest.NewRequest("GET", "/api/system/ports", nil))
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var result struct {
		Ports []listeningPort `json:"ports"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	for protocol, port := range map[string]int{"TCP": tcp.Addr().(*net.TCPAddr).Port, "UDP": udp.LocalAddr().(*net.UDPAddr).Port} {
		found := false
		for _, p := range result.Ports {
			if p.Protocol == protocol && p.Port == port && p.PID == os.Getpid() {
				found = true
			}
		}
		if !found {
			t.Errorf("missing %s port %d for this process", protocol, port)
		}
	}
}

func TestParseListeningPorts(t *testing.T) {
	for _, protocol := range []string{"TCP", "UDP"} {
		output := "p42\ng40\ncnode server\nf5\nn127.0.0.1:3000\nf6\nn127.0.0.1:3000\nf7\nn[::1]:3001\np77\ncworker\nf8\nn*:5353->1.1.1.1:53\nn*:0\nn*:65536\nn*:bad\nnnot-an-address\npbad\nn*:4000\n"
		want := []listeningPort{
			{Port: 3000, Protocol: protocol, Address: "127.0.0.1", PID: 42, PGID: 40, Process: "node server"},
			{Port: 3001, Protocol: protocol, Address: "[::1]", PID: 42, PGID: 40, Process: "node server"},
			{Port: 5353, Protocol: protocol, Address: "*", PID: 77, Process: "worker"},
		}
		if got := parseListeningPorts(output, protocol); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: got %+v, want %+v", protocol, got, want)
		}
	}
}
