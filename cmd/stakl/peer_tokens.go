package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"
	"time"
)

func runPeerTokens(inst instance, args []string) error {
	usage := fmt.Errorf("usage: stakl peer tokens create --name NAME [--access read|control] | list | revoke ID")
	if len(args) == 0 {
		return usage
	}
	method, path := "GET", "/api/peer-tokens"
	var body io.Reader
	switch args[0] {
	case "list":
		if len(args) != 1 {
			return usage
		}
	case "create":
		name, access := "", "read"
		seen := map[string]bool{}
		for i := 1; i < len(args); i += 2 {
			if i+1 >= len(args) || seen[args[i]] {
				return usage
			}
			seen[args[i]] = true
			switch args[i] {
			case "--name":
				name = args[i+1]
			case "--access":
				access = args[i+1]
			default:
				return usage
			}
		}
		if strings.TrimSpace(name) == "" || access != "read" && access != "control" {
			return usage
		}
		payload, err := json.Marshal(map[string]string{"name": name, "access": access})
		if err != nil {
			return err
		}
		body = bytes.NewReader(payload)
		method = "POST"
	case "revoke":
		if len(args) != 2 || args[1] == "" || strings.ContainsAny(args[1], "/\\?#") || args[1] == "." || args[1] == ".." {
			return usage
		}
		method = "POST"
		path += "/" + url.PathEscape(args[1]) + "/revoke"
	default:
		return usage
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	response, err := instanceClient(ctx, inst, method, path, body)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		data, _ := io.ReadAll(response.Body)
		return fmt.Errorf("peer token request: %s: %s", response.Status, strings.TrimSpace(string(data)))
	}
	var result json.RawMessage
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		return err
	}
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, result, "", "  "); err != nil {
		return err
	}
	_, err = fmt.Fprintln(os.Stdout, pretty.String())
	return err
}
