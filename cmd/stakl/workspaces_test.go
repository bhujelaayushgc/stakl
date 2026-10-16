package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWorkspaceCLIReadsListAndStatusWithoutMutations(t *testing.T) {
	requests := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.Path)
		if r.Method != "GET" || r.Header.Get("Authorization") != "Bearer secret" {
			t.Errorf("unexpected request: %s", r.Method)
		}
		switch r.URL.Path {
		case "/api/workspaces":
			w.Write([]byte(`[{"id":"memos","name":"Memos frontend","state":"unknown","required_issues":1,"optional_issues":0}]`))
		case "/api/workspaces/memos":
			w.Write([]byte(`{"id":"memos","name":"Memos frontend","state":"blocked","members":[{"alias":"backend","name":"Memos","required":true,"condition":"healthy","state":"blocked","reason":"Service health check failed","checks":[]}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"workspace", "list"}, "Memos frontend"},
		{[]string{"workspace", "status", "memos"}, "Service health check failed"},
	} {
		out, err := captureCLI(func() error { return cli(instance{URL: server.URL, Token: "secret"}, tc.args) })
		if err != nil || !strings.Contains(out, tc.want) {
			t.Fatalf("out %q, error %v", out, err)
		}
	}
	if len(requests) != 2 {
		t.Fatal(requests)
	}
	for _, args := range [][]string{{"workspace", "start", "memos"}, {"workspace", "status", "../bad"}, {"workspace"}} {
		if err := cli(instance{URL: server.URL, Token: "secret"}, args); err == nil {
			t.Fatalf("accepted %v", args)
		}
	}
	if len(requests) != 2 {
		t.Fatal("invalid arguments made request", requests)
	}
}
