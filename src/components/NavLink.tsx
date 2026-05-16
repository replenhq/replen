"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

// Header link that gets `.active` styling when the current path matches.
// Match logic:
//   - href "/"           → active only when pathname is exactly "/"
//   - href "/projects"   → active when pathname starts with "/projects"
export function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const isActive = href === "/"
    ? pathname === "/"
    : pathname === href || pathname.startsWith(href + "/");
  return (
    <a href={href} className={isActive ? "active" : undefined}>
      {children}
    </a>
  );
}
