"use client";

import { usePathname } from "next/navigation";
import type { CSSProperties, ReactNode } from "react";

// Header link that gets `.active` styling when the current path matches.
// Match logic:
//   - href "/"           → active only when pathname is exactly "/"
//   - href "/projects"   → active when pathname starts with "/projects"
export function NavLink({ href, children, style }: { href: string; children: ReactNode; style?: CSSProperties }) {
  const pathname = usePathname() ?? "/";
  const isActive = href === "/"
    ? pathname === "/"
    : pathname === href || pathname.startsWith(href + "/");
  return (
    <a href={href} className={isActive ? "active" : undefined} style={style}>
      {children}
    </a>
  );
}
