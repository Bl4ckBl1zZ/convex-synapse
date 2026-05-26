package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// registerResp mirrors the backend's agentRegisterResp (internal/api/agents.go).
type registerResp struct {
	HostID     string `json:"hostId"`
	AgentID    string `json:"agentId"`
	AgentToken string `json:"agentToken"`
	Config     struct {
		ControlURL               string `json:"controlUrl"`
		HeartbeatIntervalSeconds int    `json:"heartbeatIntervalSeconds"`
		Mode                     string `json:"mode"`
	} `json:"config"`
}

// register POSTs /v1/agents/register with the adoption token + local facts.
func register(ctx context.Context, controlURL, token string, info SystemInfo) (registerResp, error) {
	body := map[string]any{
		"token":         token,
		"hostname":      info.Hostname,
		"os":            info.OS,
		"arch":          info.Arch,
		"agentVersion":  Version,
		"dockerVersion": info.DockerVersion,
		"cpuCores":      info.CPUCores,
		"memoryMb":      info.MemoryMb,
		"diskGb":        info.DiskGb,
	}
	var out registerResp
	if err := doJSON(ctx, http.MethodPost, controlURL+"/v1/agents/register", "", body, &out); err != nil {
		return registerResp{}, err
	}
	return out, nil
}

// heartbeat POSTs /v1/agents/heartbeat authenticated with the agent token.
func heartbeat(ctx context.Context, cfg Config, info SystemInfo, observed map[string]any) error {
	body := map[string]any{
		"hostId":        cfg.HostID,
		"agentId":       cfg.AgentID,
		"hostname":      info.Hostname,
		"os":            info.OS,
		"arch":          info.Arch,
		"agentVersion":  Version,
		"dockerVersion": info.DockerVersion,
		"cpuCores":      info.CPUCores,
		"memoryMb":      info.MemoryMb,
		"diskGb":        info.DiskGb,
		"observed":      observed,
	}
	return doJSON(ctx, http.MethodPost, cfg.ControlURL+"/v1/agents/heartbeat", cfg.AgentToken, body, nil)
}

// doJSON sends a JSON request and decodes a JSON response into out (when
// non-nil). Non-2xx surfaces the API's {code,message} envelope. The bearer is
// set as a header only — never logged or echoed into an error.
func doJSON(ctx context.Context, method, url, bearer string, body, out any) error {
	var buf io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		buf = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, buf)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var e struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(raw, &e)
		if e.Message != "" {
			return fmt.Errorf("%s (%s, http %d)", e.Message, e.Code, resp.StatusCode)
		}
		return fmt.Errorf("request failed: http %d", resp.StatusCode)
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return err
		}
	}
	return nil
}
