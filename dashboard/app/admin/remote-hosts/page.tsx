"use client";

import { RemoteHostsAdminPanel } from "@/components/RemoteHostsAdminPanel";

// Remote Hosts admin — v1.19+. Configures Headscale (the Tailscale
// control plane Synapse uses to reach VPSes added via Admin → Hosts →
// "Setup remote install") without the operator SSH'ing to the box.
//
// The parent layout (admin/layout.tsx) already enforces
// is_instance_admin gating and redirects non-admins to /teams. This
// page is the panel and nothing else, matching the pattern of
// host-domain/page.tsx and dns-credentials/page.tsx.
export default function AdminRemoteHostsPage() {
  return <RemoteHostsAdminPanel />;
}
