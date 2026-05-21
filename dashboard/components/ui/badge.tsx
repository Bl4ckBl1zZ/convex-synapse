import clsx from "clsx";
import * as React from "react";

type Tone =
  | "green"
  | "yellow"
  | "red"
  | "neutral"
  // Environment-type tones (v1.7.2+). Distinct from the status tones
  // above so an operator can tell DEV (cyan, calm) from PROD (amber,
  // attention) at a glance — the status badge still carries the
  // green/yellow/red running/provisioning/failed signal independently.
  | "amber"
  | "cyan"
  | "violet";

const tones: Record<Tone, string> = {
  green: "bg-green-500/15 text-green-400 border-green-500/30",
  yellow: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
  red: "bg-red-500/15 text-red-400 border-red-500/30",
  neutral: "bg-neutral-700/40 text-neutral-300 border-neutral-700",
  amber: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  cyan: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
  violet: "bg-violet-500/15 text-violet-300 border-violet-500/30",
};

type Props = React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone };

export function Badge({ className, tone = "neutral", ...props }: Props) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide",
        tones[tone],
        className
      )}
      {...props}
    />
  );
}
