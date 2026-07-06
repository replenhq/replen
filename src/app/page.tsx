import { requireUser } from "@/lib/auth/current-user";
import { SkillHome } from "@/components/SkillHome";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await requireUser();
  return <SkillHome user={user} />;
}
