import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import type { CAC } from "cac";
import { GraphKitError } from "../../errors.js";
import { atomicWrite } from "../../fs.js";
import { TOPOLOGY_NAMES, type TopologyName } from "../../schemas/topology/index.js";
import { getTarget, isValidTarget, listTargets } from "../../targets/registry.js";
import type { TargetId } from "../../targets/types.js";
import { graphTemplate } from "../graph-templates.js";
import { ok, printFail } from "../output.js";

export type KitTarget = "claude" | "cursor";

// The kit source resolution lives in targets/kit-source.ts; re-exported here
// so `gk doctor` and existing imports keep their surface.

// Retired kit assets, listed in the kit's metadata.json as relative paths.
// Pruned from the destination on every install so upgrades drop files the kit
// no longer ships (cpSync overlays, it never deletes). Entries drive rmSync,
// so anything absolute or escaping the kit dir is refused rather than trusted.
function kitDeletions(source: string): string[] {
  const metaPath = join(source, "metadata.json");
  if (!existsSync(metaPath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch (cause) {
    throw new GraphKitError("KIT_METADATA_INVALID", `Malformed ${metaPath}`, {
      hint: "The kit's metadata.json is not valid JSON; reinstall gk or fix the file.",
      cause: String(cause),
    });
  }
  const raw = (parsed as { deletions?: unknown } | null)?.deletions;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((e) => typeof e !== "string")) {
    throw new GraphKitError("KIT_METADATA_INVALID", `${metaPath}: "deletions" must be an array of strings`, {
      hint: 'Example: "deletions": ["viewer", "skills/gk-old"]',
    });
  }
  for (const rel of raw as string[]) {
    const unsafe =
      rel === "" ||
      isAbsolute(rel) ||
      rel.split(/[\\/]/).some((seg) => seg === ".." || seg === "." || seg === ".gk.json");
    if (unsafe) {
      throw new GraphKitError("KIT_METADATA_INVALID", `${metaPath}: unsafe deletion path ${JSON.stringify(rel)}`, {
        hint: "Deletions must be relative paths inside the kit and may not traverse upward or remove .gk.json.",
      });
    }
  }
  return raw as string[];
}

import { kitSourceDir, templatesDir } from "../../targets/kit-source.js";

export { kitSourceDir, templatesDir };
// Merge the GraphKit rules section into an existing AGENTS.md.
// - null existing → the section becomes the whole file
// - no markers → append a marked section
// - markers present → refresh: replace content between (and including) the
//   graphkit:start / graphkit:end markers with the new section, preserving
//   all user content outside the markers
export function mergeAgentsMd(existing: string | null, section: string): string {
  const START = "<!-- graphkit:start -->";
  const END = "<!-- graphkit:end -->";
  const sec = section.replace(/\n+$/, "");
  if (!existing) return `${sec}\n`;
  const startIdx = existing.indexOf(START);
  const endIdx = existing.indexOf(END, startIdx === -1 ? 0 : startIdx);
  if (startIdx !== -1 && endIdx === -1) {
    // START survived but END was deleted by the user. The old append path
    // produced a second graphkit section on every refresh; "repair to EOF"
    // would silently eat any user content added after the section. Neither is
    // acceptable for a user-owned file — fail with the exact fix instead.
    throw new GraphKitError(
      "AGENTS_MD_UNCLOSED",
      "AGENTS.md has `<!-- graphkit:start -->` but no `<!-- graphkit:end -->` marker",
      {
        hint: "Re-add the end marker (or delete the managed section) and rerun `gk init`",
      },
    );
  }
  if (startIdx === -1 || endIdx === -1) {
    return `${existing.replace(/\n+$/, "")}\n${sec}\n`;
  }
  // collapse the whitespace seam after the end marker so repeated refreshes
  // don't accumulate trailing newlines (idempotent byte-for-byte on re-init)
  const rest = existing.slice(endIdx + END.length);
  const body = rest.replace(/^(\r?\n)+/, "");
  const seam = body.length < rest.length || body.length > 0 ? "\n" : "";
  return `${existing.slice(0, startIdx)}${sec}${seam}${body}`;
}

export function installKit(
  targetDir: string,
  fresh = false,
  target: KitTarget | string = "claude",
): { installed: string[] } {
  if (!isValidTarget(target)) {
    throw new GraphKitError(
      "BAD_TARGET",
      `Invalid target: ${target}. Must be one of: ${listTargets()
        .map((t) => t.id)
        .join(", ")}`,
    );
  }
  const t = getTarget(target as TargetId);
  const source = kitSourceDir(target as TargetId);
  const destDir = join(targetDir, t.installDir);

  // --force / fresh: wipe old dir and reinstall clean
  if (fresh && existsSync(destDir)) {
    rmSync(destDir, { recursive: true, force: true });
    // codex special case: skills also install into sibling .agents/skills/
    // — --force must remove stale skills there too, not just .codex/skills/
    if (t.id === "codex") {
      rmSync(join(targetDir, ".agents", "skills"), { recursive: true, force: true });
    }
  }

  mkdirSync(destDir, { recursive: true });
  // Runtime artifacts shared across hosts.
  for (const dir of ["evidence", "reports", "memory", "runs", "inbox"]) {
    mkdirSync(join(targetDir, ".graphkit", dir), { recursive: true });
  }
  // Kit-owned files always overwrite — re-running `gk init` after upgrading the
  // gk binary must refresh stale skills in existing projects. Only .gk.json
  // (user config) is preserved below; --force is the only path that removes
  // files the kit no longer ships — except metadata.json `deletions`, which
  // prunes named paths on every install so upgrades drop retired kit assets.
  cpSync(source, destDir, {
    recursive: true,
    force: true,
    // user config survives upgrades; created below if missing
    filter: (s) => basename(s) !== ".gk.json",
  });
  for (const rel of kitDeletions(source)) {
    rmSync(join(destDir, rel), { recursive: true, force: true });
    if (t.id === "codex" && rel.startsWith("skills/")) {
      rmSync(join(targetDir, ".agents", rel), { recursive: true, force: true });
    }
  }

  // codex special case: skills also install into sibling .agents/skills/
  if (t.id === "codex") {
    const skillsSrc = join(source, "skills");
    if (existsSync(skillsSrc)) {
      cpSync(skillsSrc, join(targetDir, ".agents", "skills"), { recursive: true, force: true });
    }
  }

  // rules: agents-md-sections targets merge a marked section into AGENTS.md
  // (refresh on every init so upgrades propagate rule changes)
  if (t.rulesStrategy === "agents-md-sections") {
    const sectionPath = join(source, "rules-section.md");
    if (!existsSync(sectionPath)) {
      throw new GraphKitError("RULES_SECTION_MISSING", `Bundled kits/${t.kitDirName}/rules-section.md not found`, {
        hint: `The ${target} kit declares rulesStrategy "agents-md-sections" but ships no rules-section.md; the install is incomplete. Reinstall gk or set GK_KIT_DIR to a valid kits/${t.kitDirName}/ directory.`,
      });
    }
    const section = readFileSync(sectionPath, "utf8");
    const agentsMd = join(targetDir, "AGENTS.md");
    const existing = existsSync(agentsMd) ? readFileSync(agentsMd, "utf8") : null;
    // F6: AGENTS.md is a user-owned file — crash mid-write must not shred it.
    atomicWrite(agentsMd, mergeAgentsMd(existing, section));
  }

  // settings.json is kit-owned infrastructure (hook config), always overwrite for claude
  // Cursor uses hooks.json shipped inside the cursor kit — no settings.json overwrite needed.
  if (t.hooksKind === "settings-json") {
    const settingsSrc = join(source, "settings.json");
    if (existsSync(settingsSrc)) {
      cpSync(settingsSrc, join(destDir, "settings.json"), { force: true });
    }
  }

  const gkConfig = join(destDir, ".gk.json");
  if (!existsSync(gkConfig)) {
    writeFileSync(gkConfig, JSON.stringify({ codingLevel: 0, statusline: "full" }, null, 2));
  }
  return { installed: readdirSync(destDir) };
}

function assertValidTarget(opts: { target?: string }) {
  if (!isValidTarget(opts.target ?? "")) {
    const valid = listTargets()
      .map((t) => t.id)
      .join(", ");
    printFail("BAD_TARGET", `Invalid target: ${opts.target}. Must be one of: ${valid}`, {
      details: { available: valid.split(", ") },
    });
  }
}

// Human success line for init/new: what was installed, where, for which
// target, and the next step. The next step names CLI commands — they are the
// only surface identical on every host (the /gk:* skill spellings differ).
// --json keeps the ok(result) envelope.
function installedLine(
  installDir: string,
  target: string,
  count: number,
  created?: string,
  graphWritten?: boolean,
): string {
  const prefix = created ? `created ${created} — ` : "";
  const next = graphWritten
    ? "next: `gk validate graph.yaml`, then `/gk:visualize` or `/gk:execute`"
    : "next: `gk graph new diamond > graph.yaml`, then `gk validate`";
  return `${prefix}installed ${count} entries into ${installDir}/ (target ${target}) — ${next}`;
}

export function registerKitCommands(cli: CAC) {
  cli
    .command("init", "Install the GraphKit kit into the current project")
    .example("$ gk init")
    .example("$ gk init --target cursor")
    .option("--json", "JSON output")
    .option("--force", "Remove previous install and install fresh")
    .option("--target <target>", "Kit target: claude, cursor, opencode, codex, or pi", { default: "claude" })
    .action((opts) => {
      assertValidTarget(opts);
      try {
        const result = installKit(process.cwd(), opts.force, opts.target);
        console.log(
          opts.json
            ? JSON.stringify(ok(result))
            : installedLine(getTarget(opts.target as TargetId).installDir, opts.target, result.installed.length),
        );
      } catch (e) {
        printFail("INIT_FAILED", e instanceof Error ? e.message : String(e), { json: opts.json === true });
      }
    });

  cli
    .command("new", "Scaffold a new project with the GraphKit kit")
    .example("$ gk new --dir my-project --target claude")
    .option("--dir <dir>", "Target directory (required)")
    .option("--topology <t>", "Also write a starter graph.yaml for the topology (see `gk graph topologies`)")
    .option("--json", "JSON output")
    .option("--target <target>", "Kit target: claude, cursor, opencode, codex, or pi", { default: "claude" })
    .action((opts) => {
      if (!opts.dir) {
        printFail("MISSING_DIR", "--dir is required", { json: opts.json === true });
        return;
      }
      assertValidTarget(opts);
      if (existsSync(opts.dir) && readdirSync(opts.dir).length > 0) {
        printFail("DIR_NOT_EMPTY", `Directory ${opts.dir} exists and is not empty`, { json: opts.json === true });
        return;
      }
      mkdirSync(opts.dir, { recursive: true });
      const result = installKit(opts.dir, false, opts.target);
      // D2: `--topology` writes the starter graph.yaml too — the success line
      // used to send the user off to hand-run `gk graph new` themselves.
      let topologyFile: string | undefined;
      if (opts.topology) {
        if (!TOPOLOGY_NAMES.includes(opts.topology as TopologyName)) {
          printFail("UNKNOWN_TOPOLOGY", `"${opts.topology}" is not a canonical topology`, {
            details: { available: TOPOLOGY_NAMES },
            json: opts.json === true,
          });
          return;
        }
        topologyFile = join(opts.dir, "graph.yaml");
        writeFileSync(topologyFile, graphTemplate(opts.topology as TopologyName));
      }
      console.log(
        opts.json
          ? JSON.stringify(ok({ created: opts.dir, ...(topologyFile ? { graph: topologyFile } : {}), ...result }))
          : installedLine(
              getTarget(opts.target as TargetId).installDir,
              opts.target,
              result.installed.length,
              opts.dir,
              Boolean(topologyFile),
            ),
      );
    });
}
