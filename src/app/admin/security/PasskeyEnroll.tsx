"use client";

import { useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";

// Register a WebAuthn passkey (Face/Touch ID / security key) for admin 2FA.
// Fetches options, runs the browser ceremony, posts the attestation for
// verification. On success the session is minted server-side, so we reload
// into the (now-unlocked) panel.
export function PasskeyEnroll() {
  const [label, setLabel] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function enroll() {
    setBusy(true);
    setStatus("Follow your device's prompt…");
    try {
      const optRes = await fetch("/api/admin/2fa/passkey/register/options", { method: "POST" });
      if (!optRes.ok) throw new Error("could not start registration");
      const options = await optRes.json();
      const attResp = await startRegistration({ optionsJSON: options });
      const verRes = await fetch("/api/admin/2fa/passkey/register/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response: attResp, label: label.trim() || undefined }),
      });
      const { verified } = await verRes.json();
      if (verified) {
        setStatus("Passkey registered.");
        window.location.reload();
      } else {
        setStatus("Registration could not be verified. Try again.");
      }
    } catch (e) {
      setStatus("Cancelled or failed: " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="device name (optional, e.g. MacBook)"
        style={{ padding: 6, minWidth: 240 }}
        disabled={busy}
      />
      <button type="button" onClick={enroll} disabled={busy}>
        {busy ? "Waiting…" : "Register a passkey (Face / Touch ID)"}
      </button>
      {status && <span className="meta">{status}</span>}
    </div>
  );
}
