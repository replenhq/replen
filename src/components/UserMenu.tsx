"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icons";

// Avatar button + dropdown holding the secondary nav (settings, projects,
// sources, activity, admin, sign out). Replaces the email-in-nav pattern
// with the GitHub/Linear/Notion-style avatar menu.
export function UserMenu({ email, isAdmin }: { email: string; isAdmin: boolean }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const initial = email.charAt(0).toUpperCase();

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
          <a className="dropdown-item" href="/settings" role="menuitem">
            <Icon name="settings" size={16} /> Settings
          </a>
          <a className="dropdown-item" href="/projects" role="menuitem">
            <Icon name="folder" size={16} /> Projects
          </a>
          <a className="dropdown-item" href="/sources" role="menuitem">
            <Icon name="database" size={16} /> Sources
          </a>
          <a className="dropdown-item" href="/runs" role="menuitem">
            <Icon name="activity" size={16} /> Activity
          </a>
          {isAdmin && (
            <a className="dropdown-item" href="/admin" role="menuitem">
              <Icon name="shield" size={16} /> Admin
            </a>
          )}
          <hr className="dropdown-divider" />
          <a className="dropdown-item" href="/api/logout" role="menuitem">
            <Icon name="logout" size={16} /> Sign out
          </a>
        </div>
      )}
    </div>
  );
}
