import * as React from "react";
import { Card, CardBody } from "@/components/ui/card";

// Constellation — the same node-cluster motif used elsewhere as the
// empty-state mascot. Pure SVG, no asset to ship.
export function Constellation() {
  return (
    <svg
      width="64"
      height="64"
      viewBox="0 0 64 64"
      aria-hidden
      className="text-neutral-700"
    >
      <defs>
        <linearGradient id="es-grad-shared" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#22d3ee" />
          <stop offset="1" stopColor="#a855f7" />
        </linearGradient>
      </defs>
      <g stroke="url(#es-grad-shared)" strokeWidth="1.5" strokeLinecap="round" opacity="0.7">
        <line x1="14" y1="18" x2="32" y2="32" />
        <line x1="50" y1="18" x2="32" y2="32" />
        <line x1="14" y1="50" x2="32" y2="32" />
        <line x1="50" y1="50" x2="32" y2="32" />
      </g>
      <g fill="url(#es-grad-shared)">
        <circle cx="14" cy="18" r="3" />
        <circle cx="50" cy="18" r="3" />
        <circle cx="14" cy="50" r="3" />
        <circle cx="50" cy="50" r="3" />
      </g>
      <circle cx="32" cy="32" r="4.5" fill="#0a0a0a" stroke="url(#es-grad-shared)" strokeWidth="1.5" />
    </svg>
  );
}

export function EmptyState({
  title,
  description,
  icon,
  action,
  testId,
}: {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  testId?: string;
}) {
  return (
    <Card className="overflow-hidden" data-testid={testId}>
      <CardBody className="flex flex-col items-center justify-center gap-4 px-6 py-16 text-center">
        <div className="relative">
          <div
            aria-hidden
            className="absolute inset-0 -z-10 scale-150 rounded-full bg-violet-500/10 blur-2xl"
          />
          {icon ?? <Constellation />}
        </div>
        <div>
          <p className="text-base font-semibold text-neutral-100">{title}</p>
          {description && (
            <p className="mt-1 max-w-sm text-sm text-neutral-400">{description}</p>
          )}
        </div>
        {action}
      </CardBody>
    </Card>
  );
}
