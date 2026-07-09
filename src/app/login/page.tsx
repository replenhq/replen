"use client";

import { useEffect, useState } from "react";
import {
  GoogleAuthProvider,
  GithubAuthProvider,
  sendSignInLinkToEmail,
  signInWithPopup,
} from "firebase/auth";
import { useRouter, useSearchParams } from "next/navigation";
import { auth } from "@/lib/firebase/client";

// Sign-in / sign-up landing. Three passwordless options:
//   1. Google OAuth (one click, auto-verified email)
//   2. GitHub OAuth (one click, auto-verified email — handy since users
//      need a GitHub account for the PAT step anyway)
//   3. Email magic link (fallback for users who don't want either OAuth
//      provider; uses Firebase's sendSignInLinkToEmail)
//
// All three result in a Firebase ID token; the server middleware exchanges
// it for a session cookie. No passwords stored anywhere in Replen's
// systems regardless of which method the user picks.

const EMAIL_STORAGE_KEY = "replen:emailForSignIn";

// GitHub OAuth is DISABLED for now. GitHub doesn't set Firebase's
// email_verified claim, so self-serve GitHub signup is refused server-side
// (see isOAuthVerified in src/lib/auth/current-user.ts) and dead-ends at an
// error. Google + email-link stay fully self-serve. The button + oauthSignIn
// path are kept intact below, just not rendered. Re-enable ONLY after adding a
// server-side GitHub-API email-verification check (then flip this to true).
const GITHUB_OAUTH_ENABLED = false;

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<"oauth" | "email-form" | "email-sent">("oauth");
  const [busy, setBusy] = useState<"google" | "github" | "email" | null>(null);
  const [returnTo, setReturnTo] = useState<string | null>(null);

  useEffect(() => {
    // ?returnTo= survives the OAuth popup by being passed to the
    // callback page on next-route push. For magic-link mode we
    // embed it in the action code URL so it round-trips through
    // the user's inbox + their click on the link.
    const r = searchParams.get("returnTo") ?? searchParams.get("redirect") ?? null;
    if (r && r.startsWith("/") && !r.startsWith("//")) setReturnTo(r);
  }, [searchParams]);

  async function oauthSignIn(provider: "google" | "github") {
    setBusy(provider);
    setErr(null);
    try {
      const p = provider === "google"
        ? new GoogleAuthProvider()
        : new GithubAuthProvider();
      // We don't request any extra scopes from the provider. Replen treats
      // OAuth purely as identity verification — the user pastes a separate
      // GitHub PAT in the next step that scopes precisely what we need.
      await signInWithPopup(auth, p);
      // After signInWithPopup resolves, Firebase has stored the user.
      // Navigate to the session-establish callback which posts the ID
      // token to /api/login and then routes to returnTo (or / by default).
      const cbUrl = returnTo
        ? `/login/callback?from=oauth&returnTo=${encodeURIComponent(returnTo)}`
        : "/login/callback?from=oauth";
      router.push(cbUrl);
    } catch (e) {
      setErr(prettyErr(e));
    } finally {
      setBusy(null);
    }
  }

  async function emailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy("email");
    setErr(null);
    try {
      const cbBase = `${window.location.origin}/login/callback`;
      const url = returnTo
        ? `${cbBase}?returnTo=${encodeURIComponent(returnTo)}`
        : cbBase;
      await sendSignInLinkToEmail(auth, email, { url, handleCodeInApp: true });
      window.localStorage.setItem(EMAIL_STORAGE_KEY, email);
      setMode("email-sent");
    } catch (e) {
      setErr(prettyErr(e));
    } finally {
      setBusy(null);
    }
  }

  if (mode === "email-sent") {
    return (
      <div style={{ maxWidth: 420, margin: "80px auto", textAlign: "center" }}>
        <h1 style={{ fontSize: 22, marginBottom: 12 }}>Check your inbox</h1>
        <p style={{ color: "#444", lineHeight: 1.6 }}>
          We&rsquo;ve sent a sign-in link to <strong>{email}</strong>. Click the link in that email to finish signing in.
        </p>
        <p style={{ color: "#888", fontSize: 13, marginTop: 24 }}>
          No email? Check spam, or{" "}
          <button
            onClick={() => { setMode("email-form"); setEmail(""); }}
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
    <div style={{ maxWidth: 380, margin: "80px auto", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>Sign in to Replen</h1>
      <p style={{ color: "var(--dim, #666)", fontSize: 14, marginBottom: 24 }}>
        No passwords. Pick how you want to sign in.
      </p>

      {mode === "oauth" && (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <button
              type="button"
              onClick={() => oauthSignIn("google")}
              disabled={busy !== null}
              style={oauthBtn}
              aria-busy={busy === "google"}
            >
              <GoogleIcon /> {busy === "google" ? "Opening…" : "Continue with Google"}
            </button>
            {GITHUB_OAUTH_ENABLED && (
            <button
              type="button"
              onClick={() => oauthSignIn("github")}
              disabled={busy !== null}
              style={oauthBtn}
              aria-busy={busy === "github"}
            >
              <GithubIcon /> {busy === "github" ? "Opening…" : "Continue with GitHub"}
            </button>
            )}
          </div>
          <div style={{ textAlign: "center", margin: "18px 0 12px", color: "var(--faint, #888)", fontSize: 12 }}>
            or
          </div>
          <button
            type="button"
            onClick={() => setMode("email-form")}
            style={{ ...oauthBtn, background: "transparent", borderStyle: "dashed", fontWeight: 400 }}
          >
            Sign in with an email link
          </button>
        </>
      )}

      {mode === "email-form" && (
        <>
          <form onSubmit={emailSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
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
            <button type="submit" disabled={busy === "email"} style={{ padding: 10, fontWeight: 600 }}>
              {busy === "email" ? "Sending…" : "Send sign-in link"}
            </button>
          </form>
          <p style={{ textAlign: "center", marginTop: 14, fontSize: 13 }}>
            <button
              type="button"
              onClick={() => setMode("oauth")}
              style={{ background: "none", border: "none", color: "#06f", cursor: "pointer", padding: 0, fontSize: 13 }}
            >
              ← back to Google
            </button>
          </p>
        </>
      )}

      {err && <p style={{ color: "#c33", fontSize: 13, marginTop: 16 }}>{err}</p>}

      <p style={{ marginTop: 32, fontSize: 12, color: "var(--faint, #888)", textAlign: "center", lineHeight: 1.5 }}>
        By signing in you agree to our{" "}
        <a href="https://replen.dev/terms" target="_blank" rel="noreferrer">Terms</a>
        {" "}and{" "}
        <a href="https://replen.dev/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>.
      </p>
    </div>
  );
}

const oauthBtn: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  padding: "10px 16px",
  fontSize: 14,
  fontWeight: 500,
  background: "var(--surface-1, transparent)",
  border: "1px solid var(--line-strong, #ccc)",
  borderRadius: 8,
  cursor: "pointer",
  color: "inherit",
};

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.4-.4-3.5z"/>
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 16.1 19 13 24 13c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.4 6.3 14.7z"/>
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.3l-6.2-5.2c-2 1.5-4.5 2.5-7.2 2.5-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.6 39.5 16.2 44 24 44z"/>
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.2-4.1 5.5l6.2 5.2C41 35 44 30 44 24c0-1.3-.1-2.4-.4-3.5z"/>
    </svg>
  );
}

function GithubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>
    </svg>
  );
}

function prettyErr(e: unknown): string {
  const code = (e as { code?: string })?.code ?? "";
  switch (code) {
    case "auth/popup-closed-by-user":
      return "Sign-in cancelled.";
    case "auth/popup-blocked":
      return "Your browser blocked the sign-in popup. Allow popups for this site and try again.";
    case "auth/account-exists-with-different-credential":
      return "You've signed in with a different method before for this email. Use that method instead.";
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
      return e instanceof Error ? e.message : "Couldn't sign in. Try again in a moment.";
  }
}
