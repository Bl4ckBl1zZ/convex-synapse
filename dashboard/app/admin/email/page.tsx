"use client";

import { EmailSettingsPanel } from "@/components/EmailSettingsPanel";

// Email — instance-admin surface for the transactional-email provider
// (Resend) that sends team-invite emails. The API key is stored encrypted
// at rest and never echoed. Layout (admin/layout.tsx) handles the
// is_instance_admin gate; this page is the panel and nothing else.
export default function AdminEmailPage() {
  return <EmailSettingsPanel />;
}
