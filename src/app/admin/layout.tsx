import Link from "next/link";
import { requireAdmin } from "@/lib/auth/current-user";
import { admin2faVerified } from "@/lib/admin/2fa";

export const dynamic = "force-dynamic";

// Defence-in-depth routing gate. Every /admin/* page renders inside this
// layout, so calling requireAdmin() here means a newly-added admin route can
// never ship un-gated by omission. Individual pages AND every server action
// still call requireAdmin() themselves (server actions run as their own POST
// endpoints, outside this layout's render), so the gate is layered, not moved.
// requireAdmin throws ForbiddenError -> 403, not a silent 500.
const NAV: Array<[string, string]> = [
  ["/admin", "Users"],
  ["/admin/pipeline", "Pipeline"],
  ["/admin/delivery", "Delivery"],
  ["/admin/proposals", "Sources"],
  ["/admin/audit", "Audit"],
  ["/admin/errors", "Errors"],
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin();
  // Nav only appears once 2FA has been passed this session, so the challenge
  // and enrolment pages (reached before verification) don't show links that
  // would just bounce back to /admin/verify.
  const verified = await admin2faVerified(admin.id);
  return (
    <div style={{ maxWidth: 1120, margin: "0 auto", padding: "0 16px 48px" }}>
      <header
        style={{
          display: "flex",
          gap: 16,
          alignItems: "baseline",
          flexWrap: "wrap",
          padding: "14px 0",
          borderBottom: "1px solid var(--border, #ddd)",
          marginBottom: 24,
        }}
      >
        <strong style={{ fontSize: 15 }}>Replen admin</strong>
        {verified && (
          <nav style={{ display: "flex", gap: 14, fontSize: 14 }}>
            {NAV.map(([href, label]) => (
              <Link key={href} href={href}>
                {label}
              </Link>
            ))}
            <Link href="/admin/security" style={{ color: "var(--faint,#888)" }}>2FA</Link>
          </nav>
        )}
        <span className="meta" style={{ marginLeft: "auto", fontSize: 12 }}>
          {admin.email}
        </span>
      </header>
      {children}
    </div>
  );
}
