"use client";

import { ApplySettingsPanel } from "@/components/ApplySettingsPanel";

// Apply — instance-admin toggle for Cell Control Plane reconcile apply
// (Bloco 10). OFF by default. Layout (admin/layout.tsx) handles the
// is_instance_admin gate; this page is the panel and nothing else.
export default function AdminApplyPage() {
  return <ApplySettingsPanel />;
}
