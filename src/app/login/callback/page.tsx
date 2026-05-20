"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { isSignInWithEmailLink, signInWithEmailLink, getIdToken } from "firebase/auth";
import { auth } from "@/lib/firebase/client";

// Sign-in callback. Three arrival paths:
//
//   1. OAuth popup closed       → ?from=oauth in the URL; Firebase has
//                                  already stored the user via signInWithPopup.
//                                  Just exchange the ID token for a session
//                                  cookie and redirect.
//
//   2. Email magic link click   → URL has ?apiKey=...&oobCode=...&mode=signIn.
//                                  We deliberately DO NOT consume the oobCode
//                                  on page load: email security scanners
//                                  (Gmail safety scan, Outlook SafeLinks)
//                                  pre-fetch links and would burn the one-time
//                                  code. Render a "Click to finish" button;
//                                  scanners don't click buttons, humans do.
//
//   3. Magic link in different browser → no localStorage email; ask the user
//                                          to re-type it for the signInWithEmailLink
//                                          security re-confirm.

const EMAIL_STORAGE_KEY = "replen:emailForSignIn";

export default function CallbackPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [state, setState] = useState<"confirm" | "working" | "need-email" | "error" | "oauth-exchange">("confirm");
  const [err, setErr] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [validLink, setValidLink] = useState(false);

  useEffect(() => {
    // Path 1: OAuth flow. Firebase user is already signed in; just
    // exchange the ID token for our session cookie.
    if (searchParams.get("from") === "oauth") {
      setState("oauth-exchange");
      const r = searchParams.get("returnTo");
      const safe = r && r.startsWith("/") && !r.startsWith("//") ? r : null;
      void exchangeOAuth(router, setErr, setState, safe);
      return;
    }
    // Path 2/3: email magic link.
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
  }, [searchParams, router]);

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
      const r = searchParams.get("returnTo");
      const safe = r && r.startsWith("/") && !r.startsWith("//") ? r : "/";
      router.push(safe);
    } catch (e) {
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

  if (state === "oauth-exchange") {
    return (
      <div style={{ maxWidth: 420, margin: "80px auto", textAlign: "center" }}>
        <p style={{ color: "#666" }}>Finishing sign-in…</p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 420, margin: "80px auto", textAlign: "center" }}>
      <p style={{ color: "#666" }}>Signing you in…</p>
    </div>
  );
}

// OAuth: Firebase already has the user from signInWithPopup. Just grab
// the ID token, post to /api/login to set the session cookie, then route.
async function exchangeOAuth(
  router: ReturnType<typeof useRouter>,
  setErr: (s: string | null) => void,
  setState: (s: "confirm" | "working" | "need-email" | "error" | "oauth-exchange") => void,
  returnTo: string | null,
) {
  try {
    // currentUser is populated synchronously after signInWithPopup resolves
    // and Firebase persists to IndexedDB. Wait a tick if not ready yet.
    const waited = await new Promise<typeof auth.currentUser>((resolve) => {
      if (auth.currentUser) { resolve(auth.currentUser); return; }
      const off = auth.onAuthStateChanged((user) => {
        off();
        resolve(user);
      });
    });
    const u = waited;
    if (!u) {
      setErr("Sign-in didn't complete. Try again from the sign-in page.");
      setState("error");
      return;
    }
    const idToken = await getIdToken(u);
    const res = await fetch("/api/login", { headers: { authorization: `Bearer ${idToken}` } });
    if (!res.ok) {
      let msg = `Server returned ${res.status}.`;
      try {
        const body = await res.json();
        if (body?.error) msg = body.error;
      } catch { /* non-JSON */ }
      try { await auth.signOut(); } catch { /* ignore */ }
      setErr(msg);
      setState("error");
      return;
    }
    router.push(returnTo ?? "/");
  } catch (e) {
    setErr(e instanceof Error ? e.message : "Sign-in failed.");
    setState("error");
  }
}

function prettyErr(e: unknown): string {
  const code = (e as { code?: string })?.code ?? "";
  switch (code) {
    case "auth/invalid-action-code":
    case "auth/expired-action-code":
      return "This sign-in link has expired or already been used. Request a new one from the sign-in page.";
    case "auth/invalid-email":
      return "That email didn't match the one this link was sent to.";
    default:
      return e instanceof Error ? e.message : "Sign-in failed. Try requesting a new link.";
  }
}
