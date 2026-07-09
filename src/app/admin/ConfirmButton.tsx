"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

// Client confirm-gate for irreversible admin actions (account delete). Inside a
// server-action <form>, returning false from confirm() + preventDefault stops
// the submit, so the server action only runs on an explicit yes.
export function ConfirmButton({
  message,
  children,
  ...rest
}: { message: string; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      onClick={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
