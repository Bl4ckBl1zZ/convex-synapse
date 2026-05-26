package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

const defaultHeartbeatSeconds = 15

// DockerConfig carries the agent's Docker permissions. In this block ALL of
// the allow* flags are false and unused — the agent is observe-only. They
// exist so a future apply mode is a config flip, not a schema change. The
// agent code never reads allow* today; nothing acts on them.
type DockerConfig struct {
	Enabled               bool `json:"enabled"`
	AllowContainerCreate  bool `json:"allowContainerCreate"`
	AllowContainerRestart bool `json:"allowContainerRestart"`
	AllowContainerRemove  bool `json:"allowContainerRemove"`
}

// Config is the on-disk agent config. It contains the agent token, so it is
// written 0600.
type Config struct {
	ControlURL               string       `json:"controlUrl"`
	HostID                   string       `json:"hostId"`
	AgentID                  string       `json:"agentId"`
	AgentToken               string       `json:"agentToken"`
	Mode                     string       `json:"mode"`
	HeartbeatIntervalSeconds int          `json:"heartbeatIntervalSeconds"`
	Docker                   DockerConfig `json:"docker"`
}

// defaultConfigPath is /etc/synapse-agent/config.json when running as root,
// else <user-config-dir>/synapse-agent/config.json. os.Geteuid() returns -1
// on Windows, so non-root path is used there.
func defaultConfigPath() string {
	if os.Geteuid() == 0 {
		return "/etc/synapse-agent/config.json"
	}
	dir, err := os.UserConfigDir()
	if err != nil || dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".config")
	}
	return filepath.Join(dir, "synapse-agent", "config.json")
}

func loadConfig(path string) (Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	var c Config
	if err := json.Unmarshal(b, &c); err != nil {
		return Config{}, err
	}
	return c, nil
}

// saveConfig writes the config with a 0700 parent dir and a 0600 file (it
// holds the agent token). Chmod is re-applied in case the file pre-existed
// with looser permissions.
func saveConfig(path string, c Config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		return err
	}
	_ = os.Chmod(path, 0o600)
	return nil
}
