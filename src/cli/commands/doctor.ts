import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import type { CAC } from "cac";
import { GraphKitError } from "../../errors.js";
import { listTargets } from "../../targets/registry.js";
import type { TargetId } from "../../targets/types.js";
import { APP_VERSION } from "../../version.js";
import { ok } from "../output.js";
import { loadGraph } from "./graph.js";
import { kitSourceDir } from "./kit.js";

export type DoctorStatus = "ok" | "warn" | "fail" | "info";

export interface DoctorCheck {
  check: string;
  status: DoctorStatus;
  detail: string;
}

// Test seam: in a repo checkout the bundled kits/ dir always resolves (the dev
// candidate paths exist), so the standalone-binary failure mode — binary
// extracted without its share/gk/kits tree — is unreachable. Tests inject a
// throwing resolver to exercise it, same idea as the CBM seams.
let kitSource: (targetId: TargetId) => string = kitSourceDir;
export function _setDoctorKitSource(fn: (targetId: TargetId) => string): void {
  kitSource = fn;
}
export function _resetDoctorKitSource(): void {
  kitSource = kitSourceDir;
}

// gk doctor — one-shot environment check for the 5-target workflow tool.
// Deterministic by contract: no process spawns, no network. The CBM bridge is
// probed by env configuration only (CBM_CMD/CBM_ARGS set = configured) — per
// the README the bridge being unpublished is the expected state, so this check
// can never fail; a CBM reachability probe would be neither deterministic nor
// honest, since gk itself never spawns CBM.
export function runDoctor(cwd: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  // 1. version — the same `gk/<APP_VERSION>` string cac prints for --version,
  // plus the platform-arch pair the release workflow bundles for.
  checks.push({
    check: "version",
    status: "ok",
    detail: `gk/${APP_VERSION} (${process.platform}-${process.arch})`,
  });

  // 2. kit — .gk.json is the user config `gk init` writes into <installDir>/
  // and preserves across upgrades. It never records the target id or a kit
  // version, so the target comes from which installDir holds it and freshness
  // from the kit's metadata.json version when the kit ships one (codex/pi
  // don't) — fresh = recorded version matches APP_VERSION, stale = re-init.
  const installed = listTargets()
    .map((t) => ({ t, config: join(cwd, t.installDir, ".gk.json") }))
    .filter(({ config }) => existsSync(config));
  if (installed.length === 0) {
    checks.push({ check: "kit", status: "info", detail: "no kit installed in this directory (run `gk init`)" });
  } else {
    const parts: string[] = [];
    let stale = false;
    for (const { t } of installed) {
      let version: string | null = null;
      try {
        const meta = JSON.parse(readFileSync(join(cwd, t.installDir, "metadata.json"), "utf-8")) as {
          version?: unknown;
        };
        if (typeof meta.version === "string") version = meta.version;
      } catch {
        /* kit ships no metadata.json (codex, pi) — version stays unrecorded */
      }
      if (version === null) {
        parts.push(`${t.id} (kit version not recorded)`);
      } else if (version === APP_VERSION) {
        parts.push(`${t.id} (kit ${version}, fresh)`);
      } else {
        stale = true;
        parts.push(`${t.id} (kit ${version}, stale — run \`gk init\` to refresh)`);
      }
    }
    checks.push({ check: "kit", status: stale ? "warn" : "ok", detail: `installed: ${parts.join(", ")}` });
  }

  // 3. .graphkit/ — runtime artifact root. Missing is fine (created on demand);
  // a memory/ that exists but cannot be listed is the MEMORY_DIR_UNREADABLE
  // failure mode `gk memory recall` fails on — same semantics here.
  const gkDir = join(cwd, ".graphkit");
  if (!existsSync(gkDir)) {
    checks.push({ check: "graphkit dir", status: "info", detail: "no .graphkit/ directory (created on first run)" });
  } else {
    const memDir = join(gkDir, "memory");
    if (!existsSync(memDir)) {
      checks.push({ check: "graphkit dir", status: "ok", detail: ".graphkit/ present (no memory store yet)" });
    } else {
      try {
        readdirSync(memDir);
        checks.push({ check: "graphkit dir", status: "ok", detail: ".graphkit/memory/ readable" });
      } catch (e) {
        checks.push({
          check: "graphkit dir",
          status: "fail",
          detail: `MEMORY_DIR_UNREADABLE: .graphkit/memory/ cannot be listed: ${String((e as Error)?.message ?? e)}`,
        });
      }
    }
  }

  // 4. graph.yaml — schema-validate through the same loadGraph every other
  // command uses; a present-but-broken file is a failure carrying its real code.
  const graphYaml = join(cwd, "graph.yaml");
  if (!existsSync(graphYaml)) {
    checks.push({ check: "graph.yaml", status: "info", detail: "no graph.yaml in this directory" });
  } else {
    try {
      const graph = loadGraph(graphYaml);
      checks.push({ check: "graph.yaml", status: "ok", detail: `valid (${graph.topology})` });
    } catch (e) {
      const code = e instanceof GraphKitError ? e.code : "GRAPH_YAML_INVALID";
      checks.push({
        check: "graph.yaml",
        status: "fail",
        detail: `${code}: ${String((e as Error)?.message ?? e)}`,
      });
    }
  }

  // 5. CBM bridge — env-configured check only. Unconfigured is the documented
  // default state, never a failure.
  const configured = Boolean(process.env.CBM_CMD || process.env.CBM_ARGS);
  checks.push(
    configured
      ? {
          check: "cbm bridge",
          status: "ok",
          detail: `configured via ${process.env.CBM_CMD ? "CBM_CMD" : "CBM_ARGS"}`,
        }
      : {
          check: "cbm bridge",
          status: "info",
          detail:
            "CBM_CMD/CBM_ARGS not set — bridge unconfigured (expected: @graphkit/codebase-memory-mcp is not yet published)",
        },
  );

  // 6. kit source — probe the same bundled-kits resolution `gk init` will do,
  // for every target detected above. A standalone binary extracted without its
  // share/gk/kits tree passes every other check yet dies mid-init; surface it
  // here with the exact KIT_SOURCE_MISSING hint init would print.
  if (installed.length === 0) {
    checks.push({ check: "kit source", status: "info", detail: "nothing to probe (no kit installed)" });
  } else {
    const resolved: string[] = [];
    const problems: string[] = [];
    for (const { t } of installed) {
      try {
        // t.id comes from the registry itself, so it is always a valid TargetId.
        kitSource(t.id as TargetId);
        resolved.push(t.id);
      } catch (e) {
        const code = e instanceof GraphKitError ? e.code : "KIT_SOURCE_MISSING";
        const hint = e instanceof GraphKitError && typeof e.details?.hint === "string" ? e.details.hint : null;
        problems.push(`${t.id}: ${code}: ${String((e as Error)?.message ?? e)}${hint ? ` (hint: ${hint})` : ""}`);
      }
    }
    checks.push(
      problems.length > 0
        ? { check: "kit source", status: "fail", detail: problems.join("; ") }
        : { check: "kit source", status: "ok", detail: `bundled kits/ resolvable for ${resolved.join(", ")}` },
    );
  }

  // 7. PATH shadow — another `gk` earlier in $PATH silently wins (`which gk`
  // resolves to it), so upgrades look like no-ops. Warn only: the doctor
  // contract keeps warn at exit 0, and a deliberate shadow is legitimate.
  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const binDir = dirname(process.execPath);
  const selfIdx = pathDirs.findIndex((d) => resolve(d) === resolve(binDir));
  const ahead = selfIdx === -1 ? pathDirs : pathDirs.slice(0, selfIdx);
  const shadows: string[] = [];
  for (const dir of ahead) {
    const candidate = join(dir, "gk");
    try {
      const st = statSync(candidate);
      if (st.isFile() && (st.mode & 0o111) !== 0) shadows.push(candidate);
    } catch {
      // no such file or unreadable PATH entry — not a shadow
    }
  }
  checks.push(
    shadows.length > 0
      ? {
          check: "PATH shadow",
          status: "warn",
          detail: `an earlier \`gk\` on $PATH wins over this binary: ${shadows.join(", ")}`,
        }
      : { check: "PATH shadow", status: "ok", detail: "no other gk earlier on $PATH" },
  );

  return checks;
}

// ✓ = ok, ✗ = failure, – = everything that needs attention but isn't broken
// (warn) or is simply a state report (info).
const MARKERS: Record<DoctorStatus, string> = { ok: "✓", warn: "–", fail: "✗", info: "–" };

export function summarizeDoctor(checks: DoctorCheck[]): { ok: number; warnings: number; failures: number } {
  return {
    ok: checks.filter((c) => c.status === "ok").length,
    warnings: checks.filter((c) => c.status === "warn").length,
    failures: checks.filter((c) => c.status === "fail").length,
  };
}

export function renderDoctor(checks: DoctorCheck[]): string {
  const width = Math.max(...checks.map((c) => c.check.length));
  const { ok: okN, warnings, failures } = summarizeDoctor(checks);
  const lines = checks.map((c) => `${MARKERS[c.status]} ${c.check.padEnd(width)}  ${c.detail}`);
  return [...lines, `${okN} ok, ${warnings} warnings, ${failures} failures`].join("\n");
}

export function registerDoctorCommand(cli: CAC) {
  cli
    .command("doctor", "One-shot environment check (version, kit, .graphkit dir, graph.yaml, CBM bridge)")
    .example("$ gk doctor")
    .example("$ gk doctor --json")
    .option("--json", "JSON output")
    .action((opts: { json?: boolean }) => {
      const checks = runDoctor(process.cwd());
      if (opts.json) {
        console.log(JSON.stringify(ok({ checks, summary: summarizeDoctor(checks) })));
      } else {
        console.log(renderDoctor(checks));
      }
      // F6: an honest non-zero exit only when a check actually failed —
      // warn/info stay exit 0 so doctor is script-safe.
      if (checks.some((c) => c.status === "fail")) process.exitCode = 1;
    });
}
