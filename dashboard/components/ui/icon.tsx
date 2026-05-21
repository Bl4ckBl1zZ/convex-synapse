// Tiny inline-SVG icon set. Zero dependencies — copying lucide-react
// or heroicons in would bloat the bundle for ~5 icons.
//
// All icons render at 14×14 by default to sit on the baseline of the
// neighbouring text in panel triggers ("Manage deploy keys" etc).
// They inherit `currentColor` so the parent's text colour drives the
// stroke — operators in a dim panel see dim icons; on hover they
// brighten with the text.

import * as React from "react";

type Props = React.SVGAttributes<SVGSVGElement> & { size?: number };

function Svg({ size = 14, className, children, ...rest }: Props & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

// Terminal — the CLI credentials panel.
export function IconTerminal(props: Props) {
  return (
    <Svg {...props}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </Svg>
  );
}

// Key — deploy keys panel.
export function IconKey(props: Props) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="15" r="4" />
      <path d="M10.85 12.15L19 4" />
      <line x1="18" y1="5" x2="20" y2="7" />
      <line x1="15" y1="8" x2="17" y2="10" />
    </Svg>
  );
}

// Globe — custom domains panel.
export function IconGlobe(props: Props) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1 -4 10 15.3 15.3 0 0 1 -4 -10 15.3 15.3 0 0 1 4 -10z" />
    </Svg>
  );
}
