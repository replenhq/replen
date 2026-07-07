// `npx replen autoground [on|off|status]` — the master switch for silent
// auto-reground (the in-session agent quietly re-deriving a repo's grounded
// capabilities in a background subagent when they drift from live code). Default
// on. This is the single global opt-out; there is no per-repo toggle.

import { loadConfigOrExit, apiGet, apiPost } from "./api.js";

export async function runAutoground(argv: string[]): Promise<void> {
  const sub = (argv[0] ?? "status").trim().toLowerCase();
  const cfg = await loadConfigOrExit();

  if (sub === "status" || sub === "") {
    const { enabled } = await apiGet<{ enabled: boolean }>(cfg, "/api/settings/autoground");
    console.log(`  auto-reground is ${enabled ? "ON" : "OFF"}`);
    console.log(enabled
      ? "  · Replen silently refreshes a repo's grounded capabilities in the background when its code drifts. `npx replen autoground off` to disable."
      : "  · Grounded capabilities won't auto-refresh. `npx replen autoground on` to re-enable.");
    return;
  }

  if (sub === "on" || sub === "off") {
    const enabled = sub === "on";
    await apiPost(cfg, "/api/settings/autoground", { enabled });
    console.log(`  ✓ auto-reground ${enabled ? "enabled" : "disabled"}.`);
    return;
  }

  console.error(`  unknown subcommand '${sub}'. Usage: npx replen autoground [on|off|status]`);
  process.exit(1);
}
