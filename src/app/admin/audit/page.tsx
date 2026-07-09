import { requireAdmin } from "@/lib/auth/current-user";
import { recentAdminActions } from "@/lib/admin/audit";

export const dynamic = "force-dynamic";

// Admin audit trail — every privileged mutation, actor + target + time. Admin
// actions are role-gated and cross-user by design (outside tenant isolation),
// so this is how they stay accountable.

function actionColor(action: string): string {
  if (action.includes("delete") || action.includes("reject") || action.includes("suspend")) return "#b91c1c";
  if (action.includes("approve") || action.includes("active")) return "#166534";
  return "var(--fg)";
}

export default async function AuditAdmin() {
  await requireAdmin();
  const rows = await recentAdminActions(300);

  return (
    <>
      <h1>Audit log</h1>
      <p className="meta">Every admin mutation, newest first. Append-only.</p>
      {rows.length === 0 && <p className="meta" style={{ marginTop: 16 }}>No admin actions recorded yet.</p>}
      {rows.length > 0 && (
        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table>
            <thead>
              <tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="meta">{r.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                  <td className="meta">{r.actorEmail}</td>
                  <td><code style={{ fontSize: 12, color: actionColor(r.action) }}>{r.action}</code></td>
                  <td className="meta">{r.targetLabel ?? (r.targetType ? `${r.targetType}#${r.targetId ?? "?"}` : "—")}</td>
                  <td className="meta" style={{ fontSize: 12 }}>{r.meta ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
