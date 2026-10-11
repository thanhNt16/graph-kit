// Promote — the sole deterministic writer of the host skill tree (validating
// admission, the security chokepoint). Port of autoharness hook/promoter.py
// (MIT): shape the intent against the live target in memory → run the lint
// taxonomy → only on pass write atomically (evidence slice + subfiles first,
// SKILL.md last as the commit point). REJECTED intents get `.rejected.json`
// markers — never silent; rejects are zero-write.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { listIntents, rejectedPath, type StagedIntent } from "./intents.js";
import { frontmatter, type LintFinding, lintIntent } from "./lint.js";
import { redact } from "./redact.js";
import {
  appendJsonl,
  archiveDir,
  checkSafeId,
  intentsDir,
  LEDGER_FILE,
  lastRunPath,
  runsDir,
  type SelflearnTarget,
  SKILLS_MARKER,
  selflearnDir,
  skillDirFor,
  skillFileFor,
  skillsDirFor,
  sweepTmpFiles,
  writeTextAtomic,
} from "./state.js";

export interface Verdict {
  id: string;
  kind: string;
  target: string;
  ok: boolean;
  findings: LintFinding[];
  notes: string[];
}

const MODIFY = new Set(["update", "patch", "delete"]);

const isSelfAuthored = (cwd: string, target: SelflearnTarget, name: string) =>
  existsSync(join(skillDirFor(cwd, target, name), SKILLS_MARKER));

const liveBody = (cwd: string, target: SelflearnTarget, name: string) => {
  const p = skillFileFor(cwd, target, name);
  return existsSync(p) ? readFileSync(p, "utf-8") : null;
};

function applyDelta(live: string, oldStr: string, newStr: string): string {
  const first = live.indexOf(oldStr);
  if (first === -1) throw new Error("patch old did not match the live body");
  if (live.indexOf(oldStr, first + 1) !== -1) throw new Error("patch old is ambiguous (multiple matches)");
  return live.slice(0, first) + newStr + live.slice(first + oldStr.length);
}

/** Shape the final SKILL.md text in memory — before ANY write. */
function shape(cwd: string, target: SelflearnTarget, i: StagedIntent): string | null {
  if (i.kind === "create" || i.kind === "update") return i.body!;
  if (i.kind === "patch") {
    const live = liveBody(cwd, target, i.target);
    if (live === null) throw new Error("patch target has no live body");
    return applyDelta(live, i.old!, i.new!);
  }
  return null; // delete
}

function materializeEvidence(cwd: string, target: SelflearnTarget, name: string, evidence: string): string {
  const text = redact(evidence);
  const rel = `references/evidence-${createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 8)}.md`;
  const p = join(skillDirFor(cwd, target, name), rel);
  if (!existsSync(p)) writeTextAtomic(p, `# Staged evidence (redacted)\n\n${text}\n`);
  return rel;
}

function land(cwd: string, target: SelflearnTarget, i: StagedIntent, body: string | null): string {
  const dir = skillDirFor(cwd, target, i.target);
  const evidenceRef = materializeEvidence(cwd, target, i.target, i.evidence);
  if (i.kind === "delete") {
    appendJsonl(join(dir, LEDGER_FILE), {
      kind: "delete",
      reason: i.reason,
      evidence: evidenceRef,
      absorbed_into: i.absorbed_into ?? null,
      at: new Date().toISOString(),
    });
    // Archive = move out of recall, reversible — carries sidecar + ledger along.
    const dest = join(archiveDir(cwd), `${i.target}-${Date.now().toString(36)}`);
    mkdirSync(archiveDir(cwd), { recursive: true });
    renameSync(dir, dest);
    return evidenceRef;
  }
  // Commit point: SKILL.md written last, atomically — recall never sees a
  // body pointing at unlanded provenance.
  writeTextAtomic(join(dir, "SKILL.md"), body!);
  const marker = join(dir, SKILLS_MARKER);
  const prev = existsSync(marker) ? JSON.parse(readFileSync(marker, "utf-8")) : {};
  writeTextAtomic(
    marker,
    JSON.stringify(
      {
        created_by: "selflearn",
        landed_at: prev.landed_at ?? new Date().toISOString(),
        patches: (prev.patches ?? 0) + (i.kind === "patch" ? 1 : 0),
      },
      null,
      2,
    ),
  );
  appendJsonl(join(dir, LEDGER_FILE), {
    kind: i.kind,
    reason: i.reason,
    evidence: evidenceRef,
    at: new Date().toISOString(),
  });
  return evidenceRef;
}

function reject(cwd: string, i: StagedIntent, findings: LintFinding[]): Verdict {
  writeTextAtomic(
    rejectedPath(cwd, i.id),
    JSON.stringify({ id: i.id, rejected_at: new Date().toISOString(), findings, intent: i }, null, 2),
  );
  rmSync(join(intentsDir(cwd), `${i.id}.json`), { force: true });
  return { id: i.id, kind: i.kind, target: i.target, ok: false, findings, notes: [] };
}

export function promoteOne(cwd: string, target: SelflearnTarget, i: StagedIntent): Verdict {
  try {
    checkSafeId("skill name", i.target);
  } catch (e) {
    return reject(cwd, i, [{ family: "routing", detail: (e as Error).message }]);
  }
  const exists = liveBody(cwd, target, i.target) !== null;
  if (i.kind === "create" && exists)
    return reject(cwd, i, [{ family: "routing", detail: `target "${i.target}" already exists — use update/patch` }]);
  if (i.kind !== "create" && !exists)
    return reject(cwd, i, [{ family: "routing", detail: `target "${i.target}" not found` }]);
  if (i.kind === "delete" && i.absorbed_into && !isSelfAuthored(cwd, target, i.absorbed_into))
    return reject(cwd, i, [
      { family: "absorbed_into", detail: `umbrella "${i.absorbed_into}" is not a live self-learned skill` },
    ]);

  let body: string | null;
  try {
    body = shape(cwd, target, i);
  } catch (e) {
    return reject(cwd, i, [{ family: "shape", detail: (e as Error).message }]);
  }
  const selfAuthored = MODIFY.has(i.kind) ? isSelfAuthored(cwd, target, i.target) : null;
  const findings = lintIntent(i, body, selfAuthored);
  if (findings.length) return reject(cwd, i, findings);

  try {
    land(cwd, target, i, body);
  } catch (e) {
    return reject(cwd, i, [{ family: "landing", detail: (e as Error).message }]);
  }
  rmSync(join(intentsDir(cwd), `${i.id}.json`), { force: true });
  const notes: string[] = [];
  if ((i.kind === "create" || i.kind === "update") && body && !frontmatterCat(body)) notes.push("category");
  return { id: i.id, kind: i.kind, target: i.target, ok: true, findings: [], notes };
}

const frontmatterCat = (body: string) => frontmatter(body)?.category;

/** Drain the staged-intent queue: promote each, write the run account +
 *  last_run.json one-liner source. At-least-once + atomic land = effectively
 *  exactly-once; orphans (.tmp) swept first. */
export function promoteIntents(cwd: string, opts: { target: SelflearnTarget; session?: string }) {
  const swept = sweepTmpFiles(cwd);
  const intents = listIntents(cwd, opts.session);
  const verdicts = intents.map((i) => promoteOne(cwd, opts.target, i));
  const landed = verdicts.filter((v) => v.ok).length;
  const families = [...new Set(verdicts.flatMap((v) => v.findings.map((f) => f.family)))].sort();
  if (intents.length) {
    const record = { at: new Date().toISOString(), session: opts.session ?? null, target: opts.target, verdicts };
    writeTextAtomic(join(runsDir(cwd), `promote-${Date.now().toString(36)}.json`), JSON.stringify(record, null, 2));
    writeTextAtomic(
      lastRunPath(cwd),
      JSON.stringify({
        at: record.at,
        landed,
        rejected: verdicts.length - landed,
        families,
        uncategorized: verdicts.filter((v) => v.notes.includes("category")).length,
      }),
    );
  }
  return {
    staged: intents.length,
    landed,
    rejected: verdicts.length - landed,
    families,
    swept: swept.length,
    verdicts,
  };
}
