"use client";

import { AlertSettingsPanel } from "@/components/AlertSettingsPanel";

// Alerts — instance-admin surface for deployment-down notifications
// (email to team admins + generic webhook). The webhook URL is stored
// server-side and never echoed. Layout (admin/layout.tsx) handles the
// is_instance_admin gate; this page is the panel and nothing else.
export default function AdminAlertsPage() {
  return <AlertSettingsPanel />;
}
