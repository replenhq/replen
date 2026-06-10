// Deterministic announcement classifier — the seed pack's keyword rules
// (classifier_rules_seed.csv) as code, plus the event-type → impact mapping.
// No LLM, per the cost model: regexes decide event type and severity; the
// source's event-type priors gate which rules are trusted on which source
// (a "pricing" keyword on a security page is more likely prose than news —
// only Critical rules are believed outside the source's declared priors).

export type Severity = "Low" | "Medium" | "High" | "Critical";
export const SEVERITY_ORDER: Record<Severity, number> = { Critical: 3, High: 2, Medium: 1, Low: 0 };

export type EventImpacts = {
  willBreakApp: boolean;
  securityIssue: boolean;
  billIncrease: boolean;
  upgradeNeeded: boolean;
};

type Rule = { eventType: string; severity: Severity; re: RegExp };

// Ordered most-severe-first; first accepted match wins.
const RULES: Rule[] = [
  { eventType: "actively_exploited_vulnerability", severity: "Critical", re: /exploited in the wild|known exploited|active exploitation|CISA KEV|under attack|weaponised|weaponized|mass exploitation/i },
  { eventType: "data_breach", severity: "Critical", re: /data breach|unauthorised access|unauthorized access|exposed data|customer data.{0,40}(incident|exposure)|incident involving data|token compromise|leaked credentials/i },
  { eventType: "malware_package", severity: "Critical", re: /malware|malicious package|typosquat|dependency confusion|compromised package|package hijack/i },
  { eventType: "secret_leak", severity: "Critical", re: /\b(secret|token|api key|credential|private key|signing key)s?\b.{0,40}\b(leak|exposed|compromis|rotat)/i },
  { eventType: "exploit_published", severity: "Critical", re: /proof[- ]of[- ]concept|\bpoc exploit\b|exploit (code|published|available)|weaponisation|scanner signature/i },
  { eventType: "security_vulnerability", severity: "High", re: /\bCVE-\d{4}-\d+\b|\bGHSA-[a-z0-9-]{14}\b|cvss|vulnerability|security advisory|affected versions|patched versions|remote code execution|\brce\b|privilege escalation|auth bypass/i },
  { eventType: "security_patch", severity: "High", re: /security (fix|patch|release)|fixes vulnerabilit|addresses CVE|patched/i },
  { eventType: "breaking_change", severity: "High", re: /breaking change|migration required|no longer supported|incompatible|major version|upgrade guide|required action/i },
  { eventType: "deprecation", severity: "High", re: /deprecat|sunset|end[- ]of[- ]life|\bEOL\b|retirement|will be removed|support ends/i },
  { eventType: "service_outage", severity: "High", re: /major outage|partial outage|degraded performance|service disruption|elevated errors/i },
  { eventType: "license_change", severity: "High", re: /relicens|license change|chang(?:e[ds]?|ing) (?:its |the |our )?license|switch(?:ed|ing)? to (?:the )?(?:bsl|sspl|agpl|elastic license|business source|server side public)|now licensed under|moving to (?:the )?(?:bsl|sspl|agpl|fair.?source)|no longer (?:mit|apache|open.?source)[- ]licensed|adopt(?:s|ed|ing) the (?:bsl|sspl|business source|elastic) license/i },
  { eventType: "pricing_change", severity: "Medium", re: /pricing|price (change|increase|update)|billing change|free tier|usage limit|metering|plan change|seat price|egress fees|storage fees/i },
  { eventType: "cve_update", severity: "Medium", re: /cvss score|advisory updated|affected[- ]version range|remediation guidance/i },
  { eventType: "compliance_or_trust_change", severity: "Medium", re: /soc ?2|iso ?27001|compliance certification|trust cent(re|er)|data processing agreement|\bdpa\b/i },
  // feature_launch deliberately omitted: Replen's core discovery covers
  // launches better (capability-matched), and Low-severity launch chatter is
  // exactly the noise the four-questions gate exists to kill.
];

// Which of the four product questions each event type answers "yes" to.
const IMPACTS: Record<string, EventImpacts> = {
  actively_exploited_vulnerability: { willBreakApp: false, securityIssue: true, billIncrease: false, upgradeNeeded: true },
  data_breach: { willBreakApp: false, securityIssue: true, billIncrease: false, upgradeNeeded: false },
  malware_package: { willBreakApp: false, securityIssue: true, billIncrease: false, upgradeNeeded: true },
  secret_leak: { willBreakApp: false, securityIssue: true, billIncrease: false, upgradeNeeded: false },
  exploit_published: { willBreakApp: false, securityIssue: true, billIncrease: false, upgradeNeeded: true },
  security_vulnerability: { willBreakApp: false, securityIssue: true, billIncrease: false, upgradeNeeded: true },
  security_patch: { willBreakApp: false, securityIssue: true, billIncrease: false, upgradeNeeded: true },
  breaking_change: { willBreakApp: true, securityIssue: false, billIncrease: false, upgradeNeeded: true },
  deprecation: { willBreakApp: true, securityIssue: false, billIncrease: false, upgradeNeeded: true },
  service_outage: { willBreakApp: true, securityIssue: false, billIncrease: false, upgradeNeeded: false },
  license_change: { willBreakApp: false, securityIssue: false, billIncrease: true, upgradeNeeded: true },
  pricing_change: { willBreakApp: false, securityIssue: false, billIncrease: true, upgradeNeeded: false },
  cve_update: { willBreakApp: false, securityIssue: true, billIncrease: false, upgradeNeeded: false },
  compliance_or_trust_change: { willBreakApp: false, securityIssue: false, billIncrease: false, upgradeNeeded: false },
};

export type Classification = { eventType: string; severity: Severity; impacts: EventImpacts };

// Classify a chunk of announcement text against the source's event-type
// priors. Rules whose event type the source declares are accepted at any
// severity; rules outside the priors only when Critical. Returns null when
// nothing matches — the common, correct case.
// Event types trusted on ANY source regardless of its declared priors:
// Critical rules (a breach is a breach wherever you read it) and license
// changes — no source in the seed declares license_change, yet a relicensing
// notice on a changelog or blog is exactly where the news breaks.
const ALWAYS_TRUST = new Set(["license_change"]);

export function classifyAnnouncement(text: string, sourceEventTypes: string[]): Classification | null {
  const priors = new Set(sourceEventTypes);
  let fallback: Rule | null = null;
  for (const rule of RULES) {
    if (!rule.re.test(text)) continue;
    if (priors.size === 0 || priors.has(rule.eventType) || ALWAYS_TRUST.has(rule.eventType)) {
      return { eventType: rule.eventType, severity: rule.severity, impacts: IMPACTS[rule.eventType] };
    }
    if (rule.severity === "Critical" && !fallback) fallback = rule;
  }
  if (fallback) return { eventType: fallback.eventType, severity: fallback.severity, impacts: IMPACTS[fallback.eventType] };
  return null;
}

export const EVENT_LABELS: Record<string, string> = {
  actively_exploited_vulnerability: "actively exploited vulnerability",
  data_breach: "security incident",
  malware_package: "malicious-package alert",
  secret_leak: "credential exposure",
  exploit_published: "published exploit",
  security_vulnerability: "security advisory",
  security_patch: "security patch",
  breaking_change: "breaking change",
  deprecation: "deprecation notice",
  service_outage: "service incident",
  pricing_change: "pricing change",
  license_change: "license change",
  cve_update: "advisory update",
  compliance_or_trust_change: "compliance update",
};
