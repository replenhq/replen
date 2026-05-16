"use client";

import { useState } from "react";
import { sendSignInLinkToEmail } from "firebase/auth";
import { auth } from "@/lib/firebase/client";

// Magic-link / passwordless sign-in. The flow:
//   1. User types email and submits
//   2. We call Firebase sendSignInLinkToEmail; Firebase emails them a link
//   3. We stash the email in localStorage so /login/callback can complete
//      the sign-in (Firebase requires the email parameter again at the
//      callback step, to defeat session-hijacking attacks where someone
//      forwards the magic link to a third party)
//   4. User clicks the link in their inbox → /login/callback handles it
//
// No passwords stored, no Google OAuth popup; one auth method, one
// transactional email pipeline (same custom domain Firebase Auth uses for
// every other email).

const EMAIL_STORAGE_KEY = "replen:emailForSignIn";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const url = `${window.location.origin}/login/callback`;
      await sendSignInLinkToEmail(auth, email, { url, handleCodeInApp: true });
      window.localStorage.setItem(EMAIL_STORAGE_KEY, email);
      setSent(true);
    } catch (e: any) {
      setErr(prettyErr(e));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div style={{ maxWidth: 420, margin: "80px auto", textAlign: "center" }}>
        <h1 style={{ fontSize: 22, marginBottom: 12 }}>Check your inbox</h1>
        <p style={{ color: "#444", lineHeight: 1.6 }}>
          We've sent a sign-in link to <strong>{email}</strong>. Click the link in that email to finish signing in.
        </p>
        <p style={{ color: "#888", fontSize: 13, marginTop: 24 }}>
          No email? Check spam, or{" "}
          <button
            onClick={() => { setSent(false); setEmail(""); }}
            style={{ background: "none", border: "none", color: "#06f", cursor: "pointer", padding: 0, fontSize: 13 }}
          >
            try a different email
          </button>
          .
        </p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 360, margin: "80px auto", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>Sign in to replen</h1>
      <p style={{ color: "#666", fontSize: 14, marginBottom: 20 }}>
        Type your email; we'll send you a one-time sign-in link. No password.
      </p>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <input
          type="email"
          placeholder="you@example.com"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoFocus
          style={{ padding: 10, fontSize: 15 }}
        />
        <button type="submit" disabled={busy} style={{ padding: 10, fontWeight: 600 }}>
          {busy ? "Sending…" : "Send sign-in link"}
        </button>
        {err && <p style={{ color: "#c33", fontSize: 13 }}>{err}</p>}
      </form>
    </div>
  );
}

function prettyErr(e: any): string {
  const code = e?.code ?? "";
  switch (code) {
    case "auth/invalid-email":
      return "That doesn't look like a valid email.";
    case "auth/missing-email":
      return "Type your email first.";
    case "auth/network-request-failed":
      return "Network error. Check your connection and try again.";
    case "auth/too-many-requests":
      return "Too many attempts. Wait a minute and try again.";
    case "auth/unauthorized-continue-uri":
      return "Sign-in link target isn't authorised. Contact the operator.";
    default:
      return e?.message ?? "Couldn't send the sign-in email. Try again in a moment.";
  }
}
