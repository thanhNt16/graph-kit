/** `.omp/factory.yaml` — the software-factory configuration contract
 *  (docs/superpowers/specs/2026-10-26-omp-software-factory-design.md §3.2).
 *  `loadFactoryConfig` parses; `validateFactory` is the semantic layer:
 *  lane→agent/graph references, omp tool/skill names, authority boundaries,
 *  provider env presence. */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { z } from "zod";
import { formatZodIssues, type Issue } from "../cli/diagnostics.js";
import { GraphKitError } from "../errors.js";
import { FACTORY_FORBIDDEN_TOOLS, FACTORY_WRITE_TOOLS, OMP_BUILTIN_TOOLS } from "./omp-tools.js";

export const LaneKeySchema = z.enum(["ready", "building", "qa", "review", "blocked", "done"]);
export type LaneKey = z.infer<typeof LaneKeySchema>;
export const LANES = LaneKeySchema.options;

const Duration = z.string().regex(/^\d+(ms|s|m|h)$/, 'duration like "60s", "10m", "1h"');

/** Parse "60s"|"10m"|"1h"|"500ms" → milliseconds. Throws on malformed input. */
export function parseDuration(s: string): number {
  const m = /^(\d+)(ms|s|m|h)$/.exec(s);
  if (!m) throw new GraphKitError("FACTORY_CONFIG", `invalid duration "${s}" (use ms|s|m|h)`);
  const n = Number.parseInt(m[1], 10);
  return n * { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[m[2] as "ms" | "s" | "m" | "h"];
}

export const AgentProfileSchema = z
  .object({
    model: z.string().min(1),
    thinking: z.string().optional(),
    tools: z.array(z.string()).min(1),
    skills: z.array(z.string()).default([]),
    max_time: z.string().optional(),
    budget_tokens: z.number().int().positive().optional(),
    approval_mode: z.enum(["yolo", "write"]).default("yolo"),
  })
  .strict();
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export const FactoryConfigSchema = z
  .object({
    version: z.literal(1),
    board: z
      .object({
        provider: z.enum(["local", "github", "gitlab", "jira"]),
        github: z
          .object({
            owner: z.string().min(1),
            repo: z.string().min(1),
            project_number: z.number().int().positive(),
            status_field: z.string().default("Status"),
          })
          .strict()
          .optional(),
        gitlab: z
          .object({ project: z.string().min(1), host: z.string().default("https://gitlab.com") })
          .strict()
          .optional(),
        jira: z
          .object({ host: z.string().min(1), project: z.string().min(1), status_field: z.string().optional() })
          .strict()
          .optional(),
        /** Local board dir; default `.graphkit/factory/board`. */
        local: z.object({ dir: z.string().optional() }).strict().optional(),
        lanes: z.record(LaneKeySchema, z.string()),
        halt_label: z.string().default("factory:halt"),
        intake_label: z.string().default("factory"),
      })
      .strict(),
    vcs: z
      .object({
        provider: z.enum(["local", "github", "gitlab", "bitbucket"]),
        github: z
          .object({ owner: z.string().min(1), repo: z.string().min(1) })
          .strict()
          .optional(),
        gitlab: z
          .object({ project: z.string().min(1), host: z.string().default("https://gitlab.com") })
          .strict()
          .optional(),
        bitbucket: z
          .object({ workspace: z.string().min(1), repo: z.string().min(1) })
          .strict()
          .optional(),
        base_branch: z.string().default("main"),
        branch_prefix: z.string().default("factory/"),
        merge: z
          .object({
            method: z.enum(["squash", "merge", "rebase"]).default("squash"),
            auto: z.boolean().default(false),
            require_checks: z.boolean().default(true),
          })
          .strict()
          .default({ method: "squash", auto: false, require_checks: true }),
      })
      .strict(),
    dispatch: z
      .object({
        poll_interval: Duration.default("60s"),
        max_parallel: z.partialRecord(LaneKeySchema, z.number().int().positive()).default({}),
        max_rounds: z.number().int().positive().default(3),
        halt_poll: Duration.default("15s"),
        env_passthrough: z.array(z.string()).default([]),
      })
      .strict()
      .default({ poll_interval: "60s", max_parallel: {}, max_rounds: 3, halt_poll: "15s", env_passthrough: [] }),
    agents: z.record(z.string(), AgentProfileSchema),
    /** Lane bindings: which agent profile + lane graph runs when the card is
     *  in this lane, and where it goes next. `ready` (intake) is optional. */
    lanes: z
      .object({
        ready: z
          .object({ agent: z.string(), graph: z.string(), next: LaneKeySchema.default("building") })
          .strict()
          .optional(),
        building: z.object({ agent: z.string(), graph: z.string(), next: LaneKeySchema.default("qa") }).strict(),
        qa: z.object({ agent: z.string(), graph: z.string(), next: LaneKeySchema.default("review") }).strict(),
        review: z.object({ agent: z.string(), graph: z.string(), next: LaneKeySchema.default("done") }).strict(),
      })
      .strict(),
    qa: z
      .object({
        commands: z.array(z.string()).min(1),
        ui: z
          .object({ dev_server: z.string().optional(), journeys: z.array(z.string()).default([]) })
          .strict()
          .nullish(),
      })
      .strict(),
  })
  .strict();
export type FactoryConfig = z.infer<typeof FactoryConfigSchema>;

export function loadFactoryConfig(cwd: string, path = ".omp/factory.yaml"): FactoryConfig {
  const abs = join(cwd, path);
  if (!existsSync(abs)) throw new GraphKitError("FACTORY_CONFIG", `factory config not found at ${path}`);
  let raw: unknown;
  try {
    raw = YAML.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    throw new GraphKitError("FACTORY_CONFIG", `invalid YAML in ${path}: ${String(e)}`);
  }
  const parsed = FactoryConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GraphKitError("FACTORY_CONFIG", `invalid ${path}`, {
      issues: formatZodIssues(parsed.error, FactoryConfigSchema) as unknown as Issue[],
    });
  }
  return parsed.data;
}

export interface FactoryFinding extends Issue {
  check: string;
  severity?: "warn";
}

/** Environment variables each provider requires (names only — values are
 *  never logged). */
export const PROVIDER_ENV: Record<string, string[]> = {
  github: ["GH_TOKEN", "GITHUB_TOKEN"],
  gitlab: ["GITLAB_TOKEN"],
  jira: ["JIRA_EMAIL", "JIRA_TOKEN"],
  bitbucket: ["BITBUCKET_USER", "BITBUCKET_APP_PASSWORD"],
};

/** Skills visible to omp from a project root: <root>/.omp/skills, every
 *  ancestor .omp/skills, and ~/.omp/agent/skills. */
export function skillRoots(cwd: string, home = homedir()): string[] {
  const roots: string[] = [];
  let dir = cwd;
  for (;;) {
    roots.push(join(dir, ".omp", "skills"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  roots.push(join(home, ".omp", "agent", "skills"));
  return roots;
}

export function skillExists(name: string, cwd: string, home = homedir()): boolean {
  return skillRoots(cwd, home).some((r) => existsSync(join(r, name, "SKILL.md")));
}

/** Semantic validation beyond schema shape. Returns findings (blocking unless
 *  severity === "warn"). */
export function validateFactory(cwd: string, cfg: FactoryConfig, opts?: { home?: string }): FactoryFinding[] {
  const findings: FactoryFinding[] = [];
  const knownTools = new Set<string>(OMP_BUILTIN_TOOLS);

  for (const [name, p] of Object.entries(cfg.agents)) {
    for (const t of p.tools) {
      if (!knownTools.has(t)) {
        findings.push({
          check: "FACTORY_UNKNOWN_TOOL",
          path: `agents.${name}.tools`,
          message: `unknown omp tool "${t}"`,
        });
      }
      if (FACTORY_FORBIDDEN_TOOLS.has(t)) {
        findings.push({
          check: "FACTORY_AUTHORITY",
          path: `agents.${name}.tools`,
          message: `tool "${t}" crosses the deterministic boundary (provider API / sub-agent / skill mutation)`,
        });
      }
    }
    for (const s of p.skills) {
      if (!skillExists(s, cwd, opts?.home)) {
        findings.push({
          check: "FACTORY_UNKNOWN_SKILL",
          path: `agents.${name}.skills`,
          message: `no SKILL.md found for "${s}"`,
        });
      }
    }
  }

  // Lane bindings: referenced agents exist and lane graphs resolve (graph is
  // a repo-relative .gk.yaml path or a gallery template name).
  for (const [lane, binding] of Object.entries(cfg.lanes)) {
    if (!binding) continue;
    if (!(binding.agent in cfg.agents)) {
      findings.push({
        check: "FACTORY_CONFIG",
        path: `lanes.${lane}.agent`,
        message: `agent "${binding.agent}" not defined under agents:`,
      });
    }
    const g = binding.graph;
    if (!g.endsWith(".yaml") && !g.endsWith(".yml")) {
      // Gallery name — resolve against the bundled gallery next to this module.
      const bundled = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates", "gallery", `${g}.gk.yaml`);
      if (!existsSync(bundled))
        findings.push({
          check: "FACTORY_CONFIG",
          path: `lanes.${lane}.graph`,
          message: `gallery template not found: ${g}`,
        });
    } else if (!existsSync(join(cwd, g))) {
      findings.push({ check: "FACTORY_CONFIG", path: `lanes.${lane}.graph`, message: `lane graph not found: ${g}` });
    }
    // Eval-gate lanes must not carry write tools.
    if (lane === "qa" || lane === "review") {
      const profile = cfg.agents[binding.agent];
      if (profile) {
        const writes = profile.tools.filter((t) => FACTORY_WRITE_TOOLS.has(t));
        if (writes.length > 0)
          findings.push({
            check: "FACTORY_AUTHORITY",
            path: `agents.${binding.agent}.tools`,
            message: `eval-gate lane "${lane}" profile carries write tools: ${writes.join(", ")}`,
          });
      }
    }
  }

  for (const provider of [cfg.board.provider, cfg.vcs.provider]) {
    if (provider === "local") continue;
    const required = PROVIDER_ENV[provider] ?? [];
    const present = required.filter((v) => process.env[v]);
    // OR semantics for github (GH_TOKEN or GITHUB_TOKEN); all others need every var.
    const ok = provider === "github" ? present.length > 0 : present.length === required.length;
    if (!ok) {
      findings.push({
        check: "FACTORY_MISSING_ENV",
        path: `${provider}`,
        message: `provider "${provider}" needs env: ${required.join(provider === "github" ? " or " : ", ")} (names only; values never logged)`,
        severity: "warn",
      });
    }
  }

  // Provider blocks required by the selected providers.
  if (cfg.board.provider === "github" && !cfg.board.github)
    findings.push({
      check: "FACTORY_CONFIG",
      path: "board.github",
      message: "board.provider github requires board.github",
    });
  if (cfg.board.provider === "gitlab" && !cfg.board.gitlab)
    findings.push({
      check: "FACTORY_CONFIG",
      path: "board.gitlab",
      message: "board.provider gitlab requires board.gitlab",
    });
  if (cfg.board.provider === "jira" && !cfg.board.jira)
    findings.push({ check: "FACTORY_CONFIG", path: "board.jira", message: "board.provider jira requires board.jira" });
  if (cfg.vcs.provider === "github" && !cfg.vcs.github)
    findings.push({ check: "FACTORY_CONFIG", path: "vcs.github", message: "vcs.provider github requires vcs.github" });
  if (cfg.vcs.provider === "gitlab" && !cfg.vcs.gitlab)
    findings.push({ check: "FACTORY_CONFIG", path: "vcs.gitlab", message: "vcs.provider gitlab requires vcs.gitlab" });
  if (cfg.vcs.provider === "bitbucket" && !cfg.vcs.bitbucket)
    findings.push({
      check: "FACTORY_CONFIG",
      path: "vcs.bitbucket",
      message: "vcs.provider bitbucket requires vcs.bitbucket",
    });

  for (const [lane, v] of Object.entries(cfg.dispatch.max_parallel)) {
    if (v <= 0)
      findings.push({ check: "FACTORY_CONFIG", path: `dispatch.max_parallel.${lane}`, message: "must be positive" });
  }
  return findings;
}
