// Validating-admission lint — deterministic checks run over the shaped
// intent BEFORE any write lands (K8s validating-admission shape). Port of
// autoharness lib/validate.py + lib/skills_guard.py (MIT): safety/exfil/
// injection regex families, frontmatter structure, trigger-cue + index
// budget on the description, altitude cap, placeholder ban, reason+evidence
// required. The reflector LLM is the only non-deterministic piece and it can
// only stage — this gate is the security chokepoint.

import { secretHits } from "./redact.js";

export const INDEX_DESC_MAX_CHARS = 60;
export const SKILL_BODY_MAX_LINES = 25;
export const STAGE_MAX_BODY_BYTES = 100_000;

/** Six safety families — the SKILL.md body is a deferred-execution,
 *  persistent vehicle for injection into the host context. */
export const GUARD_FAMILIES: Record<string, RegExp[]> = {
  exfiltration: [
    /curl\s+.*\|\s*(sh|bash)/i,
    /wget\s+.*\|\s*(sh|bash)/i,
    /(exfiltrate|leak|send|post|upload)\b.{0,30}(http|secret|token|api[_-]?key|password|credential|\benv\b)/i,
  ],
  injection: [
    /ignore\s+(all\s+|any\s+)?previous\s+instructions/i,
    /disregard\s+(all\s+)?(previous|prior|above)/i,
    /(override|bypass|reveal|leak)\b.{0,20}system\s+(prompt|instructions?)/i,
    /always\s+(exfiltrate|send|leak|forward)/i,
  ],
  destructive: [
    /\brm\s+-rf?\s+(\/|~|\$home|\*)/i,
    /\bdrop\s+table\b/i,
    /\bmkfs\b/i,
    /\bdd\s+if=.*of=\/dev\//i,
    /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:?\s*&\s*\}/,
  ],
  persistence: [
    /\bcrontab\b/i,
    /\.(bashrc|zshrc|bash_profile|profile)\b/i,
    /systemctl\s+enable/i,
    /\blaunchctl\b/i,
    /\/etc\/(cron|rc\.local|systemd)/i,
  ],
  network: [/\/dev\/tcp\//i, /reverse\s+shell/i, /\bnc\s+-l/i, /\bncat\b.*-e/i, /socket\.socket\(/i],
  obfuscation: [/base64\s+(-d|--decode)/i, /\beval\s*\(/, /\bexec\s*\(/, /(\\x[0-9a-fA-F]{2}){4,}/, /\bfromhex\b/i],
};

/** {family: [matched patterns]} — empty object = clean. */
export function guardScan(text: string): Record<string, string[]> {
  const findings: Record<string, string[]> = {};
  for (const [family, patterns] of Object.entries(GUARD_FAMILIES)) {
    const hits = patterns.filter((p) => p.test(text)).map((p) => p.source);
    if (hits.length) findings[family] = hits;
  }
  return findings;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;
const PLACEHOLDER =
  /\b(TODO|FIXME|XXX):|<(?:TODO|FIXME|XXX|TBD|PLACEHOLDER|REPLACE[_ ]?ME|INSERT[_ ]?HERE|FILL[_ ]?IN)>/;
const QUOTED_PHRASE = /"[^"]+"|'[^']+'|`[^`]+`/;
const WHEN = /\bwhen/i;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function frontmatter(body: string): Record<string, string> | null {
  const m = body.match(FRONTMATTER);
  if (!m) return null;
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#") || !line.includes(":")) continue;
    const idx = line.indexOf(":");
    let v = line.slice(idx + 1).trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[0] === v[v.length - 1]) v = v.slice(1, -1);
    fm[line.slice(0, idx).trim()] = v;
  }
  return fm;
}

const hasCue = (desc: string) => WHEN.test(desc) || QUOTED_PHRASE.test(desc);

export type LintFinding = { family: string; detail: string };

/** Description is the host's recall key AND the index line: over the
 *  60-char index budget it is truncated mid-clause and never routes; a
 *  cue-less topic label never fires. Both reject. */
export function descriptionFindings(desc: string): LintFinding[] {
  const findings: LintFinding[] = [];
  if (desc.length > INDEX_DESC_MAX_CHARS) {
    findings.push({
      family: "description",
      detail: `description is ${desc.length} chars — must fit the ${INDEX_DESC_MAX_CHARS}-char index budget (one sentence, trigger first, ends with a period)`,
    });
  }
  if (!hasCue(desc)) {
    findings.push({
      family: "trigger",
      detail: "description has no trigger cue: add 'use when …' and/or a literal phrase the user would type",
    });
  }
  return findings;
}

/** Structure checks (frontmatter + required keys + category shape). */
export function structureFindings(body: string): LintFinding[] {
  const fm = frontmatter(body);
  if (fm === null) return [{ family: "structure", detail: "missing/invalid frontmatter" }];
  const findings: LintFinding[] = [];
  if (!fm.name) findings.push({ family: "structure", detail: "missing name" });
  if (!fm.description) findings.push({ family: "structure", detail: "missing description" });
  const cat = fm.category;
  if (cat !== undefined && (cat.includes("/") || !SAFE_SEGMENT.test(cat))) {
    findings.push({
      family: "category",
      detail: `category ${JSON.stringify(cat)} must be a single safe segment (letters/digits/._-)`,
    });
  }
  return findings;
}

const bodyLines = (body: string) => {
  const m = body.match(FRONTMATTER);
  const rest = m ? body.slice(m[0].length) : body;
  return rest.split("\n").filter((l) => l.trim()).length;
};

/** Full admission lint over an intent + its shaped body (null for delete).
 *  `selfAuthored` = the live target carries the .selflearn marker; modify
 *  kinds reject targets we did not produce (only-touch-self-produced). */
export function lintIntent(
  intent: { kind: string; reason?: string; evidence?: string },
  body: string | null,
  selfAuthored: boolean | null,
): LintFinding[] {
  const findings: LintFinding[] = [];
  if (body !== null) {
    const guard = guardScan(body);
    for (const [fam, hits] of Object.entries(guard))
      findings.push({ family: "safety", detail: `${fam}: ${hits.join(", ")}` });
    const secrets = secretHits(body);
    if (secrets.length) findings.push({ family: "secret", detail: secrets.join(", ") });
    findings.push(...structureFindings(body));
    if (PLACEHOLDER.test(body)) findings.push({ family: "completeness", detail: "contains TODO/placeholder" });
    if (intent.kind === "create" || intent.kind === "update") {
      const n = bodyLines(body);
      if (n > SKILL_BODY_MAX_LINES) {
        findings.push({
          family: "altitude",
          detail: `body is ${n} non-blank lines (> ${SKILL_BODY_MAX_LINES}); state the rule, move detail elsewhere`,
        });
      }
      const desc = frontmatter(body)?.description;
      if (desc) findings.push(...descriptionFindings(desc));
    }
  }
  if (!(intent.reason ?? "").trim() || !(intent.evidence ?? "").trim()) {
    findings.push({ family: "led", detail: "intent missing reason/evidence" });
  }
  if (intent.kind !== "create" && selfAuthored !== true) {
    findings.push({ family: "self_produced", detail: "target live skill was not produced by gk selflearn" });
  }
  return findings;
}
