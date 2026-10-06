import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CAC } from "cac";
import { GraphKitError } from "../../errors.js";
import { getTarget, isValidTarget, listTargets } from "../../targets/registry.js";
import type { TargetId } from "../../targets/types.js";
import { APP_VERSION } from "../../version.js";
import { emit, fail, ok } from "../output.js";

/** kitVersion recorded into .gk.json at install time; compared against the
 *  running CLI version so stale kit installs are visible instead of silent. */
export function kitVersionWarnings(cwd: string): string[] {
  const warnings: string[] = [];
  for (const t of listTargets()) {
    const cfg = join(cwd, t.installDir, ".gk.json");
    if (!existsSync(cfg)) continue;
    let recorded: string | null = null;
    try {
      const parsed = JSON.parse(readFileSync(cfg, "utf8")) as Record<string, unknown>;
      if (typeof parsed.kitVersion === "string") recorded = parsed.kitVersion;
    } catch {
      /* unreadable config is not a staleness signal */
      continue;
    }
    if (recorded === APP_VERSION) continue;
    const relation = recorded !== null && compareVersions(recorded, APP_VERSION) > 0 ? "is newer than" : "predates";
    warnings.push(
      `${t.installDir}/.gk.json kitVersion=${recorded ?? "unrecorded"} ${relation} gk ${APP_VERSION} — run \`gk init --target ${t.id}\` to refresh kit files (skills/extensions/rules) before executing graphs`,
    );
  }
  return warnings;
}

/** Dotted x.y.z compare via split (no semver dependency); missing segments = 0. */
function compareVersions(a: string, b: string): number {
  const as = a.split(".");
  const bs = b.split(".");
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const d = (Number(as[i]) || 0) - (Number(bs[i]) || 0);
    if (d !== 0) return d;
  }
  return 0;
}

export type KitTarget = "claude" | "pi";

// Candidate ladder shared with template.ts's gallery lookup: resolve a bundled
// asset directory (e.g. "kits/claude", "templates/gallery") relative to however
// this package was loaded — dev tree, npm package, standalone-binary share
// layout, user-home install, or repo-root cwd. Returns the first existing
// candidate, else the dev-tree path (caller decides whether absence is fatal).
export function bundledAssetDir(relPath: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const exe = dirname(process.execPath);
  const candidates = [
    // Dev: src/cli/commands/ → package root
    join(here, "..", "..", "..", relPath),
    // npm package: dist/index.js → package root (npm link, npm install -g)
    join(here, "..", relPath),
    // Standalone binary: <bin>/share/gk/<rel>/ (extracted side-by-side with the
    // binary — wins over ../share, which may be a stale kit left by an earlier
    // install under a different prefix)
    join(exe, "share", "gk", relPath),
    // Standalone binary: <bin>/../share/gk/<rel>/
    join(exe, "..", "share", "gk", relPath),
    // User home install: ~/.graphkit/<rel>/
    join(process.env.HOME ?? "", ".graphkit", relPath),
    // cwd fallback (works from repo root)
    join(process.cwd(), relPath),
  ];
  const found = candidates.find((c) => existsSync(c));
  return found ?? join(here, "..", "..", "..", relPath);
}

// The kit source ships inside the npm package: <package-root>/kits/<target>/
// Resolve relative to this module, not process.cwd().
function kitSourceDir(targetId: TargetId = "claude"): string {
  // Explicit env override wins over every candidate
  if (process.env.GK_KIT_DIR && existsSync(process.env.GK_KIT_DIR)) return process.env.GK_KIT_DIR;

  const t = getTarget(targetId);
  const kitName = t.kitDirName;
  const dir = bundledAssetDir(join("kits", kitName));
  if (!existsSync(dir)) {
    throw new GraphKitError("KIT_SOURCE_MISSING", `Bundled kits/${kitName}/ directory not found`, {
      hint: `Set GK_KIT_DIR to the kits/${kitName}/ directory, or install the kit: sudo cp -r kits/${kitName} /usr/local/share/gk/kits/${kitName}`,
      tried: dir,
    });
  }
  return dir;
}

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

// Re-exported so graph.ts can resolve the templates dir the same way.
export function templatesDir(target: TargetId = "claude"): string {
  return join(kitSourceDir(target), "templates");
}

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

  // User config is read BEFORE the --force wipe below: --force refreshes kit
  // files but must never destroy user keys (codingLevel/statusline/custom).
  const gkConfig = join(destDir, ".gk.json");
  let existing: Record<string, unknown> = {};
  if (existsSync(gkConfig)) {
    try {
      const parsed = JSON.parse(readFileSync(gkConfig, "utf8")) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") existing = parsed;
    } catch {
      /* corrupt user config: rewrite defaults below */
    }
  }

  // --force wipes the previous install first; user config was read above and
  // is rewritten (with preserved keys) after the copy.
  if (fresh && existsSync(destDir)) {
    rmSync(destDir, { recursive: true, force: true });
  }
  mkdirSync(destDir, { recursive: true });
  // Runtime artifacts shared across hosts.
  for (const dir of ["evidence", "reports", "memory", "runs", "inbox"]) {
    mkdirSync(join(targetDir, ".graphkit", dir), { recursive: true });
  }
  // Kit-owned files always overwrite — re-running `gk init` after upgrading the
  // gk binary must refresh stale skills in existing projects. Only .gk.json
  // (user config) is preserved — read above, before the --force wipe; --force
  // is the only path that removes files the kit no longer ships — except
  // metadata.json `deletions`, which prunes named paths on every install so
  // upgrades drop retired kit assets.
  cpSync(source, destDir, {
    recursive: true,
    force: true,
    // user config survives upgrades; created below if missing
    filter: (s) => basename(s) !== ".gk.json",
  });
  for (const rel of kitDeletions(source)) {
    rmSync(join(destDir, rel), { recursive: true, force: true });
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
    const agentsExisting = existsSync(agentsMd) ? readFileSync(agentsMd, "utf8") : null;
    writeFileSync(agentsMd, mergeAgentsMd(agentsExisting, section));
  }

  // settings.json is kit-owned infrastructure (hook config), always overwritten.
  if (t.hooksKind === "settings-json") {
    const settingsSrc = join(source, "settings.json");
    if (existsSync(settingsSrc)) {
      cpSync(settingsSrc, join(destDir, "settings.json"), { force: true });
    }
  }

  // Merge (never clobber user keys): record which kit version wrote the files
  // so `gk run start` can warn when the install predates the running binary.
  writeFileSync(
    gkConfig,
    JSON.stringify({ codingLevel: 0, statusline: "full", ...existing, kitVersion: APP_VERSION }, null, 2),
  );
  return { installed: readdirSync(destDir) };
}
function assertValidTarget(opts: { target?: string }) {
  if (!isValidTarget(opts.target ?? "")) {
    const valid = listTargets()
      .map((t) => t.id)
      .join(", ");
    throw new GraphKitError("BAD_TARGET", `Invalid target: ${opts.target}. Must be one of: ${valid}`);
  }
}

export function registerKitCommands(cli: CAC) {
  cli
    .command("init", "Install the GraphKit kit into the current project")
    .option("--json", "JSON output")
    .option("--force", "Remove previous install and install fresh")
    .option("--target <target>", "Kit target: claude or pi", { default: "claude" })
    .action((opts) => {
      try {
        assertValidTarget(opts);
        const result = installKit(process.cwd(), opts.force, opts.target);
        emit(ok(result));
      } catch (e) {
        emit(e instanceof GraphKitError ? fail(e.code, e.message, e.details) : fail("INIT_FAILED", String(e)));
      }
    });

  cli
    .command("new", "Scaffold a new project with the GraphKit kit")
    .option("--dir <dir>", "Target directory (required)")
    .option("--json", "JSON output")
    .option("--target <target>", "Kit target: claude or pi", { default: "claude" })
    .action((opts) => {
      try {
        if (!opts.dir) {
          emit(fail("MISSING_DIR", "--dir is required"));
          return;
        }
        assertValidTarget(opts);
        if (existsSync(opts.dir) && readdirSync(opts.dir).length > 0) {
          emit(fail("DIR_NOT_EMPTY", `Directory ${opts.dir} exists and is not empty`));
          return;
        }
        mkdirSync(opts.dir, { recursive: true });
        const result = installKit(opts.dir, false, opts.target);
        emit(ok({ created: opts.dir, ...result }));
      } catch (e) {
        emit(e instanceof GraphKitError ? fail(e.code, e.message, e.details) : fail("NEW_FAILED", String(e)));
      }
    });
}
