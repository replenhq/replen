"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { isSignInWithEmailLink, signInWithEmailLink, getIdToken } from "firebase/auth";
import { auth } from "@/lib/firebase/client";

// Magic-link callback. The user arrives here after clicking the sign-in
// link in their inbox. Firebase appends ?apiKey=...&oobCode=...&mode=signIn
// to the URL we set as `actionCodeSettings.url` in the login page.
//
// IMPORTANT: we deliberately DO NOT consume the oobCode on page load.
// Email security scanners (Gmail's safety scan, Outlook SafeLinks, etc.)
// pre-fetch links to check for malware before the user clicks. If we
// called signInWithEmailLink on mount, the scanner's fetch would burn the
// one-time code and the human's click would fail with auth/invalid-action-code.
// Instead we render a "Click to finish signing in" button. Scanners GET the
// page; they don't run JS event handlers or click buttons. Only a real
// human click triggers the actual sign-in.

const EMAIL_STORAGE_KEY = "replen:emailForSignIn";

export default function CallbackPage() {
  const router = useRouter();
  const [state, setState] = useState<"confirm" | "working" | "need-email" | "error">("confirm");
  const [err, setErr] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [validLink, setValidLink] = useState(false);

  useEffect(() => {
    if (!isSignInWithEmailLink(auth, window.location.href)) {
      setErr("This link isn't a valid sign-in link. It may have already been used, or it expired. Request a new one from the sign-in page.");
      setState("error");
      return;
    }
    setValidLink(true);
    const stored = window.localStorage.getItem(EMAIL_STORAGE_KEY);
    if (stored) {
      setEmail(stored);
      setState("confirm");
    } else {
      // The link was opened in a different browser to the one that
      // requested it (or localStorage was cleared). Ask the user to re-type.
      setState("need-email");
    }
  }, []);

  async function finish(emailToUse: string) {
    setState("working");
    setErr(null);
    try {
      const cred = await signInWithEmailLink(auth, emailToUse, window.location.href);
      window.localStorage.removeItem(EMAIL_STORAGE_KEY);
      const idToken = await getIdToken(cred.user);
      const res = await fetch("/api/login", { headers: { authorization: `Bearer ${idToken}` } });
      if (!res.ok) {
        let msg = `Server returned ${res.status}.`;
        try {
          const body = await res.json();
          if (body?.error) msg = body.error;
        } catch { /* non-JSON */ }
        try { await auth.signOut(); } catch { /* ignore */ }
        throw new Error(msg);
      }
      router.push("/");
    } catch (e: any) {
      setErr(prettyErr(e));
      setState("error");
    }
  }

  if (state === "confirm" && validLink) {
    return (
      <div style={{ maxWidth: 420, margin: "80px auto", textAlign: "center" }}>
        <h1 style={{ fontSize: 22, marginBottom: 8 }}>One more step</h1>
        <p style={{ color: "#444", lineHeight: 1.6, marginBottom: 20 }}>
          Signing in as <strong>{email}</strong>.
        </p>
        <button
          onClick={() => void finish(email)}
          style={{ padding: "10px 20px", fontWeight: 600, fontSize: 15 }}
        >
          Finish signing in
        </button>
        <p style={{ color: "#888", fontSize: 12, marginTop: 24 }}>
          This extra click keeps the sign-in link safe from email-provider link scanners.
        </p>
      </div>
    );
  }

  if (state === "need-email") {
    return (
      <div style={{ maxWidth: 420, margin: "80px auto" }}>
        <h1 style={{ fontSize: 22 }}>Confirm your email</h1>
        <p style={{ color: "#444", lineHeight: 1.6, marginBottom: 16 }}>
          For security, please type the email this link was sent to.
        </p>
        <form
          onSubmit={(e) => { e.preventDefault(); void finish(email.trim()); }}
          style={{ display: "flex", gap: 8 }}
        >
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            autoFocus
            style={{ padding: 8, flex: 1 }}
          />
          <button type="submit" style={{ padding: 8 }}>Continue</button>
        </form>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div style={{ maxWidth: 420, margin: "80px auto", textAlign: "center" }}>
        <h1 style={{ fontSize: 22 }}>Sign-in failed</h1>
        <p style={{ color: "#c33", lineHeight: 1.6, marginBottom: 16 }}>{err}</p>
        <a href="/login" style={{ color: "#06f" }}>Back to sign in</a>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 420, margin: "80px auto", textAlign: "center" }}>
      <p style={{ color: "#666" }}>Signing you in…</p>
    </div>
  );
}

function prettyErr(e: any): string {
  const code = e?.code ?? "";
  switch (code) {
    case "auth/invalid-action-code":
    case "auth/expired-action-code":
      return "This sign-in link has expired or already been used. Request a new one from the sign-in page.";
    case "auth/invalid-email":
      return "That email didn't match the one this link was sent to.";
    default:
      return e?.message ?? "Sign-in failed. Try requesting a new link.";
  }
}
