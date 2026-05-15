"use client";

import { useState } from "react";
import { authorizeCli } from "./actions";

export function CliAuthForm({ port, state }: { port: number; state: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onAuthorize() {
    setBusy(true);
    setErr(null);
    const r = await authorizeCli(port, state);
    if (r.ok) {
      // Top-level navigation to the CLI's localhost callback. The CLI server
      // listens on that port, reads the token + state from the query string,
      // returns a success page, then exits.
      window.location.href = r.callback;
    } else {
      setBusy(false);
      setErr(r.error);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={onAuthorize}
        disabled={busy}
        style={{
          background: "#0a0a0a",
          color: "#fff",
          border: "none",
          padding: "10px 18px",
          borderRadius: 6,
          fontSize: 15,
          fontWeight: 500,
          cursor: busy ? "wait" : "pointer",
          opacity: busy ? 0.7 : 1,
        }}
      >
        {busy ? "Authorizing…" : "Authorize CLI on this computer →"}
      </button>
      {err && <p style={{ color: "#c33", fontSize: 13, marginTop: 12 }}>{err}</p>}
    </>
  );
}
