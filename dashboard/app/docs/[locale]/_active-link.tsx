"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

// A Link wrapper that toggles a class when the current pathname matches.
// Lives in the docs route only — the dashboard doesn't have many active-
// state-aware links, so a shared util would be over-abstraction.
export function ActiveLink({
  href,
  className,
  activeClassName,
  children,
}: {
  href: string;
  className: string;
  activeClassName: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const isActive = pathname === href;
  return (
    <Link href={href} className={isActive ? activeClassName : className}>
      {children}
    </Link>
  );
}
