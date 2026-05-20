"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icons";

// Avatar button + dropdown holding the secondary nav (settings, projects,
// sources, activity, admin, sign out). Replaces the email-in-nav pattern
// with the GitHub/Linear/Notion-style avatar menu.
export function UserMenu({ email, isAdmin, demoMode }: { email: string; isAdmin: boolean; demoMode?: boolean }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const initial = email.charAt(0).toUpperCase();
  // Prefix nav hrefs with /demo when in the demo sandbox so dropdown
  // clicks stay inside /demo/*.
  const navPrefix = demoMode ? "/demo" : "";

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="user-menu" ref={wrapperRef}>
      <button
        type="button"
        className="avatar-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${email}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="avatar">{initial}</span>
      </button>
      {open && (
        <div className="dropdown" role="menu">
          <div className="dropdown-head">
            <span className="avatar" aria-hidden="true">{initial}</span>
            <span className="dropdown-email">{email}</span>
          </div>
          <a className="dropdown-item" href={`${navPrefix}/settings`} role="menuitem">
            <Icon name="settings" size={16} /> Settings
          </a>
          <a className="dropdown-item" href={`${navPrefix}/projects`} role="menuitem">
            <Icon name="folder" size={16} /> Projects
          </a>
          <a className="dropdown-item" href={`${navPrefix}/sources`} role="menuitem">
            <Icon name="database" size={16} /> Sources
          </a>
          <a className="dropdown-item" href={`${navPrefix}/runs`} role="menuitem">
            <Icon name="activity" size={16} /> Activity
          </a>
          {isAdmin && (
            <a className="dropdown-item" href="/admin" role="menuitem">
              <Icon name="shield" size={16} /> Admin
            </a>
          )}
          <hr className="dropdown-divider" />
          {demoMode ? (
            // Demo: replace Sign out with a Back-to-main CTA. Demo visitors
            // shouldn't be able to "sign out" of a session they never signed
            // in to; the natural next step from a demo is leaving for the
            // real signed-out site (where the sign-up CTA lives).
            <a className="dropdown-item" href="/" role="menuitem" style={{ color: "var(--amber)", fontWeight: 600 }}>
              <Icon name="arrow-right" size={16} /> Back to main site
            </a>
          ) : (
            <a className="dropdown-item" href="/api/logout" role="menuitem">
              <Icon name="logout" size={16} /> Sign out
            </a>
          )}
        </div>
      )}
    </div>
  );
}
