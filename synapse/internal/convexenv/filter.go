package convexenv

import "strings"

// managedNames is the canonical list of env-var names the Convex CLI
// manages itself (deploy creds + frontend public vars). Mirroring this
// list keeps Synapse's pushed env clean of CLI-only names that, if set
// in the function store, would either be ignored or worse, override
// whatever the operator did via npx convex / their framework.
//
// Source: get-convex/convex-backend npm-packages/convex/src/cli/lib/env.ts
// (envSetFromContent's managedVars set). Keep in sync if upstream adds new
// names — a stale list here is a silent leak.
var managedNames = map[string]struct{}{
	"CONVEX_DEPLOY_KEY":            {},
	"CONVEX_DEPLOYMENT_TOKEN":      {},
	"CONVEX_DEPLOYMENT":            {},
	"CONVEX_SELF_HOSTED_URL":       {},
	"CONVEX_SELF_HOSTED_ADMIN_KEY": {},
	"NEXT_PUBLIC_CONVEX_URL":       {},
	"NEXT_PUBLIC_CONVEX_SITE_URL":  {},
}

// IsManagedName reports whether name is reserved for CLI / framework
// use and should be dropped before pushing to the Convex function env
// store. Case-sensitive match against the canonical name.
func IsManagedName(name string) bool {
	_, ok := managedNames[strings.TrimSpace(name)]
	return ok
}

// FilterManaged returns changes with managed-name entries removed.
// dropped is the names that were filtered (caller can log a warning).
func FilterManaged(changes []Change) (keep []Change, dropped []string) {
	keep = make([]Change, 0, len(changes))
	for _, c := range changes {
		if IsManagedName(c.Name) {
			dropped = append(dropped, c.Name)
			continue
		}
		keep = append(keep, c)
	}
	return keep, dropped
}
