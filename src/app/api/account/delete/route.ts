import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { deleteUserAndAllData } from "@/lib/account-delete";
import { removeAuthCookies } from "next-firebase-auth-edge/lib/next/cookies";
import { authConfig } from "@/lib/auth/config";
import { publicUrlFrom } from "@/lib/forwarded-url";

// Irreversible account deletion (right-to-erasure). Posted from the /settings
// danger zone. Erases the user and ALL their data in one transaction:
//   - the ~26 tables with an ON DELETE CASCADE foreign key to users go
//     automatically when the users row is deleted;
//   - the tables that carry a user_id but NO cascade FK (graph_nodes,
//     graph_edges, user_graph_meta, atlas_carts) are deleted explicitly first
//     so they aren't left orphaned;
//   - two non-cascade audit references (curated_sources.added_by_user_id,
//     proposed_sources.reviewed_by_user_id) are nulled so a NO ACTION foreign
//     key can't block the users delete.
// Requires a typed "DELETE" confirmation so a stray click can't wipe an account.
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.redirect(publicUrlFrom(req, "/login"), { status: 303 });
  }

  const form = await req.formData().catch(() => null);
  const confirm = (form?.get("confirm") ?? "").toString().trim();
  if (confirm !== "DELETE") {
    return NextResponse.redirect(publicUrlFrom(req, "/settings?error=confirm-delete"), { status: 303 });
  }

  const userId = user.id;
  await deleteUserAndAllData(userId);
  console.log(`[account] deleted user ${userId} and all owned data`);

  // Clear the Firebase session cookies (same pattern as /api/logout) and bounce
  // to the signed-out page.
  const cleared = await removeAuthCookies(req.headers, {
    cookieName: authConfig.cookieName,
    cookieSerializeOptions: authConfig.cookieSerializeOptions,
  });
  const res = NextResponse.redirect(publicUrlFrom(req, "/signed-out"), { status: 303 });
  cleared.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") res.headers.append("set-cookie", value);
  });
  return res;
}
