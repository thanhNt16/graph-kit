// Deterministic admission lint for learned content — no LLM call, so the
// gate cannot be argued past by the text it is inspecting (ported from
// autoharness lib/validate.py + lib/skills_guard.py). Safety families are
// hard rejects (`LEARN_LINT`); trigger/altitude are advisory findings that
// land in the proposal record without blocking adoption.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { LearnProposal } from "./schema.js";

export interface LintFinding {
  family: string;
  /** The offending line (trimmed, truncated), or a short detail string for
   *  advisory families that have no single offending line. */
  line: string;
  severity: "hard" | "advisory";
}

/** SKILL.md body altitude cap — past it, detail belongs in references/, not
 *  the always-loaded body. */
const ALTITUDE_MAX_LINES = 200;
const LINE_MAX = 160;

/** curl/wget reaching a non-localhost host with a $VAR or secret-ish ref in
 *  the same line — the classic "pipe the token out" shape. */
const REMOTE_FETCH_WITH_SECRET =
  /\b(?:curl|wget)\b(?![^\n]*\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])\b)[^\n]*\$\{?\w+/i;

const SAFETY_FAMILIES: Record<string, RegExp[]> = {
  // Prompt-injection: the learned text itself is the vehicle into the host's
  // context — override directives and role reassignment are never adoptable.
  injection: [
    /\bignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above)\s+instructions?\b/i,
    /\bdisregard\s+(?:all\s+)?(?:previous|prior|above)\b/i,
    /\b(?:override|bypass|reveal|leak)\b.{0,20}\bsystem\s+(?:prompt|instructions?)\b/i,
    /\b(?:you are now|act as|from now on you are|assume the role of|new role:|role:\s*(?:system|admin|root))\b/i,
    /\balways\s+(?:exfiltrate|send|leak|forward)\b/i,
  ],
  // Exfiltration: remote fetch with a variable payload, send/upload verbs
  // aimed at secrets, and credential-file reads.
  exfiltration: [
    /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sh|bash)\b/i,
    REMOTE_FETCH_WITH_SECRET,
    /\b(?:exfiltrate|leak|send|post|upload)\b.{0,30}\b(?:secret|token|api[_-]?key|password|credential|\benv\b|https?:\/\/)/i,
    /~?\/?\.ssh\/|\bid_rsa\b|\.aws\/credentials|\.netrc\b|\b\.env\b|credentials\.json/i,
  ],
  // Destructive shell the learned text directs the host to run.
  destructive: [
    /\brm\s+-\w*f\w*\s+\S/i,
    /\bchmod\s+(?:-R\s+)?777\b/i,
    /\bdrop\s+table\b/i,
    /\bmkfs\b/i,
    /\bdd\s+if=\S*of=\/dev\//i,
  ],
  // Persistence / self-replication: hooks that survive the session, or
  // directives to copy the learned item into other skills/kits/agents.
  persistence: [
    /\bcrontab\b/i,
    /\.(?:bashrc|zshrc|bash_profile|profile)\b/,
    /\bsystemctl\s+enable\b/i,
    /\blaunchctl\b/i,
    /\/etc\/(?:cron|rc\.local|systemd)/i,
    /\b(?:replicate|propagate|copy\s+(?:yourself|itself|this\s+skill))\b/i,
    /\b(?:install|copy|write|add)\b.{0,40}\b(?:this|itself)\b.{0,30}\b(?:skill|kit|agent)\b/i,
  ],
};

const QUOTED_PHRASE = /"[^"]+"|'[^']+'|`[^`]+`/;
const WHEN_CUE = /\bwhen\b/i;
const FRONTMATTER = /^---\n([\s\S]*?)\n---/;

const fit = (text: string, limit: number): string => {
  const flat = text.split(/\s+/).join(" ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 3)}...`;
};

/** A firing description names WHEN to apply the item ("use when …") or
 *  carries a literal phrase the user would type; a bare topic-label never
 *  fires (autoharness `description_findings`). */
const hasTriggerCue = (desc: string): boolean => WHEN_CUE.test(desc) || QUOTED_PHRASE.test(desc);

/** `description:` field from frontmatter, or null. */
function frontmatterDescription(text: string): string | null {
  const m = text.match(FRONTMATTER);
  if (!m) return null;
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i < 0 || line.slice(0, i).trim() !== "description") continue;
    let v = line.slice(i + 1).trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
    return v;
  }
  return null;
}

/** Non-blank body lines, frontmatter excluded — the altitude proxy. */
function bodyLines(text: string): number {
  const m = text.match(FRONTMATTER);
  const rest = m ? text.slice(m[0].length) : text;
  return rest.split("\n").filter((l) => l.trim()).length;
}

/** Safety scan: first matched line per family → hard finding. */
export function scanSafety(text: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const lines = text.split("\n");
  for (const [family, patterns] of Object.entries(SAFETY_FAMILIES)) {
    for (const line of lines) {
      if (!patterns.some((re) => re.test(line))) continue;
      findings.push({ family, line: fit(line, LINE_MAX), severity: "hard" });
      break;
    }
  }
  return findings;
}

/**
 * Lint the learned content a proposal would install: hypothesis + evidence,
 * the proposed SKILL.md body (when it exists on disk), and a command fix.
 * Hard findings name a safety family; advisory findings cover the missing
 * trigger cue and the altitude cap.
 */
export function lintProposal(cwd: string, proposal: LearnProposal): LintFinding[] {
  const findings: LintFinding[] = [];
  const skillPath = proposal.proposes?.skill_path;
  let skillBody: string | null = null;
  if (skillPath) {
    const src = isAbsolute(skillPath) ? skillPath : resolve(cwd, skillPath);
    if (existsSync(src)) skillBody = readFileSync(src, "utf-8");
  }

  const surfaces = [proposal.hypothesis, proposal.evidence ?? "", skillBody ?? ""];
  if (proposal.fix?.kind === "command") surfaces.push(proposal.fix.value);
  for (const text of surfaces) {
    if (text.trim()) findings.push(...scanSafety(text));
  }

  const desc = (skillBody !== null ? frontmatterDescription(skillBody) : null) ?? proposal.hypothesis;
  if (!hasTriggerCue(desc)) {
    findings.push({
      family: "trigger",
      line: fit(desc, LINE_MAX) || "(empty description)",
      severity: "advisory",
    });
  }

  if (skillBody !== null) {
    const n = bodyLines(skillBody);
    if (n > ALTITUDE_MAX_LINES) {
      findings.push({
        family: "altitude",
        line: `body is ${n} non-blank lines (> ${ALTITUDE_MAX_LINES}); state the rule, move detail to references/`,
        severity: "advisory",
      });
    }
  }
  return findings;
}
