import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";

export const dynamic = "force-dynamic";

export default async function PendingPage() {
  const user = await getCurrentUser().catch(() => null);
  if (!user) redirect("/login");
  if (user.status === "active") redirect("/");

  return (
    <div style={{ maxWidth: 480, margin: "80px auto", textAlign: "center" }}>
      <h1 style={{ fontSize: 22, marginBottom: 12 }}>You're on the list</h1>
      <p style={{ color: "#444", lineHeight: 1.6 }}>
        Replen is in private beta. The admin of this instance has been notified
        and will review your account. You'll see the dashboard here as soon as
        they approve.
      </p>
      <p style={{ color: "#888", fontSize: 13, marginTop: 24 }}>
        Signed in as <strong>{user.email}</strong>. <a href="/api/logout">Sign out</a>.
      </p>
    </div>
  );
}
