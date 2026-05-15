"use client";

import { useState } from "react";
import {
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  sendPasswordResetEmail,
  getIdToken,
} from "firebase/auth";
import { auth } from "@/lib/firebase/client";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function bindServer(idToken: string) {
    const res = await fetch("/api/login", { headers: { authorization: `Bearer ${idToken}` } });
    if (!res.ok) throw new Error(`server: ${res.status}`);
    router.push("/");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null); setInfo(null);
    try {
      const cred = await signInWithEmailAndPassword(auth, email, password);
      const idToken = await getIdToken(cred.user);
      await bindServer(idToken);
    } catch (e: any) {
      setErr(prettyErr(e));
    } finally {
      setBusy(false);
    }
  }

  async function google() {
    setBusy(true); setErr(null); setInfo(null);
    try {
      const provider = new GoogleAuthProvider();
      const cred = await signInWithPopup(auth, provider);
      const idToken = await getIdToken(cred.user);
      await bindServer(idToken);
    } catch (e: any) {
      setErr(prettyErr(e));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!email) { setErr("Type your email first, then click Reset"); return; }
    setBusy(true); setErr(null); setInfo(null);
    try {
      await sendPasswordResetEmail(auth, email);
      setInfo(`Reset email sent to ${email}. Check your inbox.`);
    } catch (e: any) {
      setErr(prettyErr(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 360, margin: "60px auto", fontFamily: "system-ui, sans-serif" }}>
      <h1>Sign in</h1>

      <button
        onClick={google}
        disabled={busy}
        style={{ width: "100%", padding: 10, marginBottom: 16, fontWeight: 600 }}
      >
        Continue with Google
      </button>

      <div style={{ textAlign: "center", color: "#888", fontSize: 12, margin: "8px 0" }}>or</div>

      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <input
          type="email"
          placeholder="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          style={{ padding: 8 }}
        />
        <input
          type="password"
          placeholder="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ padding: 8 }}
        />
        <button type="submit" disabled={busy} style={{ padding: 8 }}>
          {busy ? "signing in…" : "Sign in with password"}
        </button>
        <button type="button" onClick={reset} disabled={busy} style={{ padding: 4, background: "none", border: "none", color: "#06f", textAlign: "left", cursor: "pointer", fontSize: 13 }}>
          Forgot password? Send reset email
        </button>
        {err && <p style={{ color: "#c33", fontSize: 13 }}>{err}</p>}
        {info && <p style={{ color: "#2a2", fontSize: 13 }}>{info}</p>}
      </form>

    </div>
  );
}

function prettyErr(e: any): string {
  const code = e?.code ?? "";
  switch (code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "Wrong email or password. Try Google sign-in or send a reset email.";
    case "auth/popup-closed-by-user":
      return "Sign-in popup closed.";
    case "auth/network-request-failed":
      return "Network error — check your connection.";
    case "auth/too-many-requests":
      return "Too many attempts — wait a minute and try again.";
    default:
      return e?.message ?? "Sign in failed.";
  }
}
