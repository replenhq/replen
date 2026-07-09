"use client";

import { useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";

// Unlock the admin panel with a registered passkey. On success the server mints
// the 2FA session cookie, so we navigate into /admin.
export function PasskeyButton() {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function verify() {
    setBusy(true);
    setStatus("Follow your device's prompt…");
    try {
      const optRes = await fetch("/api/admin/2fa/passkey/authenticate/options", { method: "POST" });
      if (!optRes.ok) throw new Error("could not start");
      const { options } = await optRes.json();
      const asseResp = await startAuthentication({ optionsJSON: options });
      const verRes = await fetch("/api/admin/2fa/passkey/authenticate/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response: asseResp }),
      });
      const { verified } = await verRes.json();
      if (verified) {
        window.location.href = "/admin";
      } else {
        setStatus("Could not verify. Try the code below, or try again.");
      }
    } catch (e) {
      setStatus("Cancelled or failed: " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button type="button" onClick={verify} disabled={busy} style={{ padding: "10px 16px", fontWeight: 600 }}>
        {busy ? "Waiting…" : "Unlock with passkey (Face / Touch ID)"}
      </button>
      {status && <p className="meta" style={{ marginTop: 8 }}>{status}</p>}
    </div>
  );
}
