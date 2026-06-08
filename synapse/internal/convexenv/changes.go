// Package convexenv talks to a Convex backend's environment-variable
// HTTP API — the same surface npx convex env set/list hits. Synapse uses
// it to push the project's "Default environment variables" panel into
// the Convex FUNCTION runtime env store (the one functions actually
// read), not the container process env (which functions never see).
package convexenv

import "encoding/json"

// Change is one env-var mutation in a batch. Value == nil unsets the
// var; non-nil sets it. The Convex backend accepts a mixed batch in a
// single POST and applies atomically (all-or-none).
type Change struct {
	Name  string
	Value *string // nil → unset
}

// MarshalJSON emits {"name": ..., "value": ... | null} — the exact
// shape the backend's UpdateEnvVarsRequest expects (see upstream
// crates/local_backend/src/environment_variables.rs:14).
func (c Change) MarshalJSON() ([]byte, error) {
	type wire struct {
		Name  string  `json:"name"`
		Value *string `json:"value"`
	}
	return json.Marshal(wire{Name: c.Name, Value: c.Value})
}

// Set is a convenience: build a Change that sets Name to Value.
func Set(name, value string) Change { return Change{Name: name, Value: &value} }

// Unset is a convenience: build a Change that unsets Name.
func Unset(name string) Change { return Change{Name: name} }
