import { getDemoUser } from "@/lib/auth/demo-mode";
import { SkillHome } from "@/components/SkillHome";

export const dynamic = "force-dynamic";

// /demo — public, anonymous-visitor-friendly snapshot of what Replen
// looks like after a few weeks of use. Uses the seeded demo user
// (email DEMO_USER_EMAIL, default demo@replen.dev) populated by
// scripts/seed-demo-skill.ts. All interactions are read-only:
// /api/state and /api/triage never run because there's no MCP token
// associated with the demo user that the agent could write back
// through.
//
// The persistent "Demo · seeded snapshot" banner above the app
// header is wired in layout.tsx based on the route path, not the
// user identity, so signed-in users browsing /demo also see the
// banner.

export default async function DemoHome() {
  const user = await getDemoUser();
  return <SkillHome user={user} demoMode />;
}
