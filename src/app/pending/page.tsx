import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";

export const dynamic = "force-dynamic";

// Suspended-account holding page. Only ever rendered for users whose
// status is something other than "active" — currently that means an
// admin has explicitly suspended them, or a legacy "pending" row
// from before self-serve signup flipped on. Active users land on /.
export default async function PendingPage() {
  const user = await getCurrentUser().catch(() => null);
  if (!user) redirect("/login");
  if (user.status === "active") redirect("/");

  const isLegacyPending = user.status === "pending";

  return (
    <div style={{ maxWidth: 480, margin: "80px auto", textAlign: "center" }}>
      <h1 style={{ fontSize: 22, marginBottom: 12 }}>
        {isLegacyPending ? "Account awaiting activation" : "Account paused"}
      </h1>
      <p style={{ color: "#444", lineHeight: 1.6 }}>
        {isLegacyPending
          ? "Your account was created before self-serve signup launched. Drop us a line at support@replen.dev and we'll flip it on."
          : "This account has been suspended. If you think that's a mistake, email support@replen.dev."}
      </p>
      <p style={{ color: "#888", fontSize: 13, marginTop: 24 }}>
        Signed in as <strong>{user.email}</strong>. <a href="/api/logout">Sign out</a>.
      </p>
    </div>
  );
}
