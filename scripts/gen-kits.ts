// gen-kits.ts — materialize the host kits from kits/_core (the canonical source).
//
// Usage:
//   bun run scripts/gen-kits.ts                 # regenerate kits/ in place (staged to temp, then swapped)
//   bun run scripts/gen-kits.ts --out <dir>     # write generated kits to <dir>/<host>; kits/ untouched
//   bun run scripts/gen-kits.ts --check         # diff generated output against kits/; exit 1 on drift
//   bun run scripts/gen-kits.ts --only <host>   # limit to one host (claude|pi)
//
// Transform table — extracted from the actual host-vs-_core diffs (2026-09-18 audit):
//
// | aspect            | claude                     | pi          |
// |-------------------|----------------------------|-------------|
// | skills dir        | skills/                    | skills/     |
// | skill SKILL.md    | fm `name: gk-x` → `gk:x`;  | verbatim    |
// |                   | rest verbatim              |             |
// | install-dir refs  | `.omp/agents/` → `<installDir>/<agentsDir>/`, `.omp/skills/` → `<installDir>/<skillsDir>/` in every copied .md (pi: identity) |
// | agents format     | md frontmatter             | bare prompt |
// |                   | name/description/model:    | verbatim    |
// |                   | tier/graph_roles/          |             |
// |                   | evidence_keys/source       |             |
// | agent body        | _core minus the leading "You are <slug>, acting as an isolated subagent…" line (all hosts but pi) |
// | agent models      | tier keyword (opus/sonnet/haiku) | n/a   |
// | rules             | rules/*.md (3 files: `# Title` + `## Validation`/`## Inviolable Rules`/`## Rules` wrappers) | rules-section.md verbatim |
// | rules body        | _core sections; `.omp/agents/` → `<installDir>/<agentsDir>/` |
// | prompts/, extensions/ | —                          | copied verbatim |
// | extras (checked-in host files, copied verbatim, never synthesized) |
// |                   | metadata.json settings.json .gk.json templates/ hooks/ schemas/ | — |
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { TARGET_MODEL_DEFAULTS } from "../src/targets/model-tiers.js";

const ROOT = resolve(import.meta.dir, "..");
const CORE = join(ROOT, "kits", "_core");
const KITS = join(ROOT, "kits");

export const HOST_IDS = ["claude", "pi"] as const;
export type HostId = (typeof HOST_IDS)[number];

interface RuntimeGuards {
  heading: string;
  intro: string;
  extraBullet?: string;
}

interface RuleFile {
  file: string;
  title: string;
  wrapper: string; // section heading inserted between intro and list ("## Validation" etc.) or the intro sentence for routing
}

interface HostConfig {
  agentsDir: string;
  skillsDir: string;
  installDir: string;
  skillNameStyle: "dash" | "colon";
  rules: "rules-dir" | "rules-section";
  ruleFiles?: RuleFile[];
  runtimeGuards?: RuntimeGuards;
  verbatimCoreDirs?: string[];
  extras?: string[];
  label: string;
  skillOverrides?: Record<string, SkillOverride>;
}

// ---- gk-execute per-host dispatch semantics ----
// The _core skill is host-neutral except the dispatch call shape; hosts with a
// different dispatch tool replace that one section (see SkillOverride below).

const CLAUDE_DISPATCH_SHAPE = `## Dispatch call shape

Spawn one parallel subagent per node via the **Agent tool** — all calls for the wave in a single message, collect every result, then proceed. Each node's definition lives at \`.claude/agents/gk-<node-id>.md\` (materialized by \`gk graph agents\`); read it first for identity, rules, and deliverables.

Each Agent call gets:
- \`subagent_type: "general-purpose"\` plus the node's agent definition as context
- prompt: the node's \`objective\`, upstream results from \`depend_on\` nodes, and its \`refs\`
- \`model\` set to the node's \`model\` tier

Results arrive as async deliveries; full output at \`agent://<name>\`, transcript at \`history://<name>\`.
`;

const GK_EXECUTE_OVERRIDES: Record<Exclude<HostId, "pi">, SkillOverride> = {
  claude: {
    description:
      'Execute a graph.yaml by directly spawning parallel subagents via the Agent tool — you apply judgment (CHALLENGE adjudication, gate questions, worktree escalation); deterministic protocol is engine-owned, `gk exec` runs it headless. Trigger: "execute graph", "run graph directly", "spawn agents for graph", "batch the graph".',
    sections: { "Dispatch call shape": CLAUDE_DISPATCH_SHAPE },
  },
};
// Skill-invocation spelling per host: _core writes `visualize --mode`; claude
// invokes skills as `/gk:visualize`.
const VISUALIZE_INVOCATION: Record<Exclude<HostId, "pi">, [string, string][]> = {
  claude: [
    ["`visualize --ascii`", "`/gk:visualize --ascii`"],
    ["`visualize --svg`", "`/gk:visualize --svg`"],
    ["`visualize --excalidraw`", "`/gk:visualize --excalidraw`"],
    ["`visualize`", "`/gk:visualize`"],
  ],
};

const HOSTS: Record<HostId, HostConfig> = {
  claude: {
    label: "Claude Code",
    agentsDir: "agents",
    skillsDir: "skills",
    installDir: ".claude",
    skillNameStyle: "colon",
    skillOverrides: {
      "gk-execute": GK_EXECUTE_OVERRIDES.claude,
      "gk-visualize": { replaces: VISUALIZE_INVOCATION.claude },
      "gk-init-graph": { replaces: [["`visualize`", "`/gk:visualize`"]] },
    },
    rules: "rules-dir",
    ruleFiles: [
      { file: "agent-binding.md", title: "Agent Binding", wrapper: "## Validation" },
      { file: "graph-authority.md", title: "Graph Authority", wrapper: "## Inviolable Rules" },
      {
        file: "topology-routing.md",
        title: "Topology Routing",
        wrapper: "Decision tree for suggesting topology in `/gk:init-graph`.\n\n## Rules",
      },
    ],
    extras: ["metadata.json", "settings.json", ".gk.json", "templates", "hooks", "schemas"],
  },
  pi: {
    label: "pi",
    agentsDir: "agents",
    skillsDir: "skills",
    installDir: ".omp",
    skillNameStyle: "dash",
    rules: "rules-section",
    verbatimCoreDirs: ["prompts", "extensions"],
  },
};

// Per-agent kit metadata (frontmatter/TOML fields). Canonical prose lives in
// kits/_core/agents/*.md (bare prompts); this table carries only the structured
// metadata those bare prompts cannot express. Extracted from the 2026-09-18 kit diff.
interface AgentMeta {
  title: string;
  description: string;
  tier: "opus" | "sonnet" | "haiku";
  graphRoles: string[];
  evidenceKeys: string[];
  source: string;
}

const AGENT_META: Record<string, AgentMeta> = {
  "agents-orchestrator": {
    title: "Agents Orchestrator",
    description:
      "Autonomous pipeline manager that orchestrates the entire development workflow. You are the leader of this process.",
    tier: "opus",
    graphRoles: ["scouter", "synthesizer"],
    evidenceKeys: ["task_breakdown", "agent_assignments", "orchestration_log"],
    source: "agency-agents/specialized-agents-orchestrator",
  },
  "code-reviewer": {
    title: "Code Reviewer",
    description:
      "Expert code reviewer who provides constructive, actionable feedback focused on correctness, maintainability, security, and performance — not style preferences.",
    tier: "sonnet",
    graphRoles: ["worker", "verifier"],
    evidenceKeys: ["findings", "severity", "remediation", "lines_affected"],
    source: "agency-agents/engineering-code-reviewer",
  },
  "data-engineer": {
    title: "Data Engineer",
    description:
      "Expert data engineer specializing in building reliable data pipelines, lakehouse architectures, and scalable data infrastructure. Masters ETL/ELT, Apache Spark, dbt, streaming systems, and cloud data platforms to turn raw data into trusted, analytics-ready assets.",
    tier: "sonnet",
    graphRoles: ["worker", "scouter"],
    evidenceKeys: ["schema_changes", "data_quality", "migration_plan"],
    source: "agency-agents/engineering-data-engineer",
  },
  "document-generator": {
    title: "Document Generator",
    description:
      "Expert document creation specialist who generates professional PDF, PPTX, DOCX, and XLSX files using code-based approaches with proper formatting, charts, and data visualization.",
    tier: "sonnet",
    graphRoles: ["synthesizer", "worker"],
    evidenceKeys: ["report", "executive_summary", "recommendations"],
    source: "agency-agents/specialized-specialized-document-generator",
  },
  "memory-curator": {
    title: "Memory Curator",
    description:
      "Curates the run's memory graph — extract, consolidate, resolve, expire, and decide whether to inject a reminder into the next action node (or stay silent).",
    tier: "opus",
    graphRoles: ["curator", "injector"],
    evidenceKeys: ["memory_delta", "injection_decision", "expired_memories"],
    source: "synthesized (Memanto + MAGMA + EvoMemKG + Genesys)",
  },
  "qa-engineer": {
    title: "QA Engineer",
    description:
      "Evidence-driven QA specialist who audits implementations with visual proof, tests interactive elements, and validates against specifications. Merges evidence collection and model QA expertise.",
    tier: "haiku",
    graphRoles: ["verifier", "worker"],
    evidenceKeys: ["test_results", "bug_reports", "coverage_gaps"],
    source: "agency-agents/testing-evidence-collector+specialized-model-qa",
  },
  "software-architect": {
    title: "Software Architect",
    description:
      "Expert software architect specializing in system design, domain-driven design, architectural patterns, and technical decision-making for scalable, maintainable systems.",
    tier: "opus",
    graphRoles: ["scouter", "planner", "synthesizer"],
    evidenceKeys: ["architecture_decisions", "trade_offs", "context_map"],
    source: "agency-agents/engineering-software-architect",
  },
  "ui-ux-researcher": {
    title: "UI/UX Researcher",
    description:
      "Expert in user experience research and UI design systems. Bridges user behavior analysis with visual design — from usability testing and personas to component libraries and pixel-perfect interfaces with accessibility compliance.",
    tier: "sonnet",
    graphRoles: ["worker", "synthesizer"],
    evidenceKeys: ["design_specs", "accessibility_audit", "user_flows"],
    source: "agency-agents/design-ux-researcher+design-ui-designer",
  },
  "security-auditor": {
    title: "Security Auditor",
    description:
      "Application-security specialist who audits code and config for exploitable vulnerabilities — every finding names the exploit path, CWE, and minimal remediation.",
    tier: "opus",
    graphRoles: ["verifier", "worker"],
    evidenceKeys: ["vulnerabilities", "severity", "exploit_path", "remediation"],
    source: "wshobson-agents/comprehensive-review-security-auditor",
  },
  implementer: {
    title: "Implementer",
    description:
      "General-purpose code worker who executes a ticket end-to-end — implements exactly what the acceptance criteria specify and proves it with real test output.",
    tier: "sonnet",
    graphRoles: ["worker"],
    evidenceKeys: ["files_changed", "implementation_summary", "tests_run", "acceptance_status"],
    source: "synthesized (ticket-worker pattern: zachwills dispatch-outcomes + Claude Code general-purpose)",
  },
  "codebase-scout": {
    title: "Codebase Scout",
    description:
      "Fast read-only explorer who maps unfamiliar code into structure maps and path:line answers — compresses the repo so downstream nodes don't burn context.",
    tier: "sonnet",
    graphRoles: ["scouter"],
    evidenceKeys: ["findings", "structure_map", "files_read"],
    source: "synthesized (Claude Code Explore built-in + Anthropic subagent-as-compression)",
  },
  "adversarial-reviewer": {
    title: "Adversarial Reviewer",
    description:
      "Refutation-first independent verifier — tries to break the work, re-runs checks itself, and emits a machine-parsed VERDICT that gates loop exit.",
    tier: "sonnet",
    graphRoles: ["verifier"],
    evidenceKeys: ["verdict", "findings", "could_not_verify"],
    source: "synthesized (HN adversarial review loops + Claude Code second-opinion pattern)",
  },
  "claim-verifier": {
    title: "Claim Verifier",
    description:
      "Cheap mechanical checker who verifies concrete 'done' claims against the repo — PASS/FAIL/UNVERIFIED per claim with file:line or command-output proof.",
    tier: "haiku",
    graphRoles: ["verifier"],
    evidenceKeys: ["claim_results"],
    source: "synthesized (zachwills cheap claim-checkers + Anthropic rubric LLM-as-judge)",
  },
  debugger: {
    title: "Debugger",
    description:
      "Root-cause specialist — reproduces the failure, bisects hypotheses one variable at a time, and proves the diagnosis before proposing a minimal fix.",
    tier: "sonnet",
    graphRoles: ["worker", "verifier"],
    evidenceKeys: ["root_cause", "reproduction", "hypotheses_tried", "fix_plan"],
    source: "wshobson-agents/error-debugging-debugger + systematic-debugging bisection",
  },
  planner: {
    title: "Planner",
    description:
      "Decomposition specialist who turns an objective into tickets a stranger could execute — scope, acceptance criteria, anti-goals, and file-ownership splits.",
    tier: "opus",
    graphRoles: ["planner"],
    evidenceKeys: ["ticket", "acceptance_criteria", "open_questions"],
    source: "synthesized (zachwills ticket-as-interface + aider architect/editor split + Claude Code plan mode)",
  },
  "research-analyst": {
    title: "Research Analyst",
    description:
      "External-source investigator who answers questions with cited evidence — every claim carries a URL and date; contradictions and gaps are flagged, not smoothed.",
    tier: "sonnet",
    graphRoles: ["scouter", "synthesizer"],
    evidenceKeys: ["findings", "citations", "options_compared", "open_questions"],
    source: "synthesized (Anthropic multi-agent research system shape; VoltAgent body rejected as padding)",
  },
  arbiter: {
    title: "Arbiter",
    description:
      "Multi-candidate judge for tournament topologies — scores candidates on declared criteria, surfaces the lone dissenter, and emits a verdict with what would flip it.",
    tier: "opus",
    graphRoles: ["verifier"],
    evidenceKeys: ["verdict", "score_matrix", "dissent", "what_would_flip"],
    source: "synthesized (Anthropic arbiter pattern: 12x vuln yield vs independent agents; tournament judge slot)",
  },
  "test-automator": {
    title: "Test Automator",
    description:
      "Test-suite author who writes tests that fail on real bugs — behavior, boundaries, invariants, transitions; never tautologies or implementation-pinning.",
    tier: "sonnet",
    graphRoles: ["worker"],
    evidenceKeys: ["tests_added", "coverage_map", "tests_run", "gaps"],
    source: "synthesized (test-quality contract: observable behavior only, every test must be able to fail)",
  },
  "performance-engineer": {
    title: "Performance Engineer",
    description:
      "Measurement-first optimizer — baselines, profiles the real bottleneck, fixes it, and proves the gain with before/after numbers from the same harness.",
    tier: "sonnet",
    graphRoles: ["worker", "verifier"],
    evidenceKeys: ["baseline", "bottlenecks", "optimizations", "after_metrics", "validation"],
    source: "synthesized (measure-before-optimize contract; no numbers = no claim)",
  },
  "api-designer": {
    title: "API Designer",
    description:
      "Contract-design specialist — consumer-first interfaces with consistent conventions, designed error shapes, and a mandatory breaking-change matrix.",
    tier: "opus",
    graphRoles: ["planner", "synthesizer"],
    evidenceKeys: ["contract", "breaking_change_matrix", "decisions", "versioning_policy"],
    source: "synthesized (contract-first design + breaking-change classification)",
  },
  "release-manager": {
    title: "Release Manager",
    description:
      "Go/no-go release gate — verifies version, changelog, tests, and artifacts against reality and emits a machine-parsed GO/NO-GO verdict with blockers.",
    tier: "sonnet",
    graphRoles: ["verifier"],
    evidenceKeys: ["go_no_go", "checklist", "blockers", "residual_risks"],
    source: "synthesized (release-checklist gate; verdict-first contract like adversarial-reviewer)",
  },
  "devops-engineer": {
    title: "DevOps Engineer",
    description:
      "CI/CD and infrastructure specialist — pinned, reproducible, minimal pipelines with cheap-checks-first ordering and validated config changes.",
    tier: "sonnet",
    graphRoles: ["worker"],
    evidenceKeys: ["changes", "pipeline_diagram", "validation", "risks"],
    source: "synthesized (reproducible-pipeline contract; pin everything, fail fast)",
  },
  "migration-planner": {
    title: "Migration Planner",
    description:
      "Incremental migration designer — expand-contract paths where every step is reversible, every intermediate state works, and every consumer has a migration step.",
    tier: "sonnet",
    graphRoles: ["planner", "worker"],
    evidenceKeys: ["delta", "steps", "consumers", "risks"],
    source: "synthesized (expand-contract pattern; no flag-day, every step reversible)",
  },
  "doc-sync": {
    title: "Doc Sync",
    description:
      "Documentation-drift sweeper — extracts checkable claims from docs, verifies them against code, and repairs or reports stale/wrong/missing content.",
    tier: "haiku",
    graphRoles: ["worker", "verifier"],
    evidenceKeys: ["drift", "summary", "unverifiable"],
    source: "synthesized (grep-deterministic drift sweep; code is truth, docs must match)",
  },
};

// _core text references the pi install dir (.omp); every other host gets its own
// install dir substituted, respecting singular/plural dir names.
function substituteInstallDirs(text: string, host: HostId): string {
  if (host === "pi") return text;
  const cfg = HOSTS[host];
  return text
    .replaceAll(".omp/agents/", `${cfg.installDir}/${cfg.agentsDir}/`)
    .replaceAll(".omp/skills/", `${cfg.installDir}/${cfg.skillsDir}/`);
}

// Section-level per-host overrides for skills whose dispatch semantics are
// host-real (dispatch mechanism, model map, tool names). Sourced from the
// pre-generator kit texts (git history, 2026-09-18) — _core carries only the
// pi-shaped sections.
//
// - `replaces`: literal find→replace on the raw _core text (before install-dir
//   substitution), for one-off lines like the Step-2 agent-resolution item.
// - `sections`: exact `## Heading` in _core → replacement body including the
//   heading line; the section runs to the next `## ` heading or EOF.
// - `description`: frontmatter `description:` replacement (mentions the host's
//   real dispatch tool).
interface SkillOverride {
  description?: string;
  replaces?: [string, string][];
  sections?: Record<string, string>;
}

function replaceSection(text: string, heading: string, body: string): string {
  const start = text.indexOf(`## ${heading}`);
  if (start === -1) throw new Error(`gen-kits: section override target not found: '## ${heading}'`);
  const next = text.indexOf("\n## ", start + 1);
  return next === -1 ? text.slice(0, start) + body : text.slice(0, start) + body + text.slice(next);
}

function transformSkillMd(raw: string, host: HostId, skillDirName: string): string {
  const cfg = HOSTS[host];
  const ov = cfg.skillOverrides?.[skillDirName];
  // Literal find→replace overrides run on the RAW _core text (their needles are
  // written in _core's `.omp/…` spelling); only then retarget install dirs.
  let text = raw;
  for (const [find, replaceWith] of ov?.replaces ?? []) {
    if (!text.includes(find))
      throw new Error(`gen-kits: override target not found in ${skillDirName}: '${find.slice(0, 60)}…'`);
    text = text.replaceAll(find, replaceWith);
  }
  text = substituteInstallDirs(text, host)
    // _core was seeded from the pi dogfood copy; retarget host-inventory probes.
    .replaceAll("--target pi", `--target ${host}`)
    // Same seeding artifact: _core names the wrong host product here.
    .replaceAll("active Cursor installation", `active ${cfg.label} installation`);
  if (ov) {
    for (const [heading, body] of Object.entries(ov.sections ?? {})) text = replaceSection(text, heading, body);
    if (ov.description) text = text.replace(/^description: .*$/m, `description: ${ov.description}`);
  }
  if (cfg.skillNameStyle === "colon" && skillDirName.startsWith("gk-")) {
    text = text.replace(/^name: gk-/m, "name: gk:");
  }
  return text;
}

// Agents in _core are bare prompts whose first line addresses the dispatching
// harness ("You are <slug>, acting as an isolated subagent…"). Hosts with typed
// agent definitions drop that line — their frontmatter/TOML replaces it.
function agentBody(raw: string, host: HostId): string {
  if (host === "pi") return raw;
  const nl = raw.indexOf("\n");
  const body = nl === -1 ? "" : raw.slice(nl + 1);
  return body.replace(/^\n+/, "");
}
function emitAgent(slug: string, raw: string, host: HostId): string {
  const meta = AGENT_META[slug];
  if (!meta) throw new Error(`gen-kits: no AGENT_META entry for agent '${slug}'`);
  if (host === "pi") {
    // omp task discovery requires name + description frontmatter; without it
    // the fragment is invisible to the native task tool and only reachable
    // through the gk_dispatch_agent child-process path.
    return `---\nname: ${slug}\ndescription: ${meta.description}\n---\n\n${raw}`;
  }
  const body = agentBody(raw, host);
  const fm = [
    "---",
    `name: ${meta.title}`,
    `description: ${meta.description}`,
    `model: ${meta.tier}`,
    `graph_roles: [${meta.graphRoles.join(", ")}]`,
    `evidence_keys: [${meta.evidenceKeys.join(", ")}]`,
    `source: ${meta.source}`,
  ];
  fm.push("---");
  return `${fm.join("\n")}\n\n${body}`;
}

function copyExtra(from: string, to: string): void {
  if (resolve(from) === resolve(to)) return; // in-place regen: extra already lives at the target
  cpSync(from, to, { recursive: true });
}

function coreRulesSections(): { name: string; body: string }[] {
  const raw = readFileSync(join(CORE, "rules-section.md"), "utf8");
  const sections: { name: string; body: string }[] = [];
  let current: { name: string; body: string[] } | null = null;
  for (const line of raw.split("\n")) {
    const heading = line.match(/^### (.+)$/);
    if (heading) {
      if (current) sections.push({ name: current.name, body: current.body.join("\n").trim() });
      current = { name: heading[1].trim(), body: [] };
    } else if (current && !line.startsWith("<!-- graphkit:")) {
      current.body.push(line);
    }
  }
  if (current) sections.push({ name: current.name, body: current.body.join("\n").trim() });
  return sections;
}

const RUNTIME_GUARD_BULLETS = [
  "- **Never edit files under `.graphkit/state/` directly** — run state mutations only through `gk` CLI commands (`gk memory`, `gk graph`). Direct edits corrupt leases and decay bookkeeping.",
  "- **Never edit `.graphkit/evidence/**` while a run is active** (`.graphkit/runs/.active` exists) — evidence files are workflow-owned during a run.",
  "- **Never hand-edit `.graphkit/evidence/.index` or `.graphkit/memory/.index`** — they are derived; regenerate via `gk memory touch` / `gk memory trace`.",
  "- After writing OKF memory files by hand, run `gk memory trace` once so decay scores and the dirty flag reflect the new reality.",
];

function emitRulesSection(host: HostId): string {
  const raw = readFileSync(join(CORE, "rules-section.md"), "utf8");
  if (host === "pi") return raw;
  const guards = HOSTS[host].runtimeGuards;
  if (!guards) throw new Error(`gen-kits: host '${host}' uses rules-section but declares no runtimeGuards`);
  let text = substituteInstallDirs(raw, host);
  const bullets = [...RUNTIME_GUARD_BULLETS, ...(guards.extraBullet ? [guards.extraBullet] : [])];
  const section = [guards.heading, "", guards.intro, "", ...bullets, ""].join("\n");
  text = text.replace("<!-- graphkit:end -->", `${section}<!-- graphkit:end -->`);
  return text;
}

function emitRulesDirFile(section: { name: string; body: string }, rule: RuleFile, host: HostId): string {
  const body = substituteInstallDirs(section.body, host);
  const [intro, ...rest] = body.split("\n\n");
  return `# ${rule.title}\n\n${intro}\n\n${rule.wrapper}\n\n${rest.join("\n\n")}\n`;
}

export function generateKit(host: HostId, outRoot: string): string {
  const cfg = HOSTS[host];
  const out = join(outRoot, host);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  // Skills: copy each _core skill, then retarget install-dir references in
  // every text file (.md prose, .py helper scripts — HEAD shipped stale `.omp/`
  // paths in the python helpers) and apply per-host SKILL.md transforms.
  for (const skill of readdirSync(join(CORE, "skills"))) {
    const dest = join(out, cfg.skillsDir, skill);
    cpSync(join(CORE, "skills", skill), dest, { recursive: true });
    for (const f of textFiles(dest)) {
      const raw = readFileSync(f, "utf8");
      const text = basename(f) === "SKILL.md" ? transformSkillMd(raw, host, skill) : substituteInstallDirs(raw, host);
      writeFileSync(f, text);
    }
  }

  // Pass through host-only skill files the canonical source does not carry yet
  // (e.g. gk-visualize/references/ — identical across hosts, pending promotion
  // into kits/_core). Prevents silent deletion on regeneration.
  const checkedInSkills = join(KITS, host, cfg.skillsDir);
  if (existsSync(checkedInSkills)) {
    for (const e of readdirSync(checkedInSkills, { withFileTypes: true })) {
      const skill = e.name;
      if (!e.isDirectory()) continue;
      const hostDir = join(checkedInSkills, skill);
      if (!existsSync(hostDir)) continue;
      for (const f of walkTree(hostDir)) {
        const rel = f.slice(hostDir.length + 1);
        const dest = join(out, cfg.skillsDir, skill, rel);
        if (!existsSync(dest)) {
          mkdirSync(dirname(dest), { recursive: true });
          cpSync(f, dest);
        }
      }
    }
  }

  // Agents.
  mkdirSync(join(out, cfg.agentsDir), { recursive: true });
  for (const file of readdirSync(join(CORE, "agents"))) {
    const slug = file.replace(/\.md$/, "");
    writeFileSync(
      join(out, cfg.agentsDir, file),
      emitAgent(slug, readFileSync(join(CORE, "agents", file), "utf8"), host),
    );
  }

  // Rules.
  if (cfg.rules === "rules-dir") {
    const sections = coreRulesSections();
    mkdirSync(join(out, "rules"), { recursive: true });
    for (const rule of cfg.ruleFiles ?? []) {
      const section = sections.find((s) => rule.file.startsWith(s.name));
      if (!section) throw new Error(`gen-kits: no _core rules section matches '${rule.file}'`);
      writeFileSync(join(out, "rules", rule.file), emitRulesDirFile(section, rule, host));
    }
  } else {
    writeFileSync(join(out, "rules-section.md"), emitRulesSection(host));
  }

  // pi-only verbatim dirs (prompts, extensions).
  for (const dir of cfg.verbatimCoreDirs ?? []) {
    cpSync(join(CORE, dir), join(out, dir), { recursive: true });
  }

  // Checked-in host extras: copied verbatim, never synthesized.
  for (const extra of cfg.extras ?? []) {
    const src = join(KITS, host, extra);
    if (!existsSync(src))
      throw new Error(`gen-kits: ${host} declares extra '${extra}' but kits/${host}/${extra} is missing`);
    copyExtra(src, join(out, extra));
  }
  return out;
}

function walkTree(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkTree(p));
    else out.push(p);
  }
  return out;
}

function textFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...textFiles(p));
    else if (/\.(md|mdc|py|ts|json|toml|txt|yaml|yml)$/.test(e.name)) out.push(p);
  }
  return out;
}

export function walkFiles(dir: string, prefix = ""): Record<string, string> {
  const files: Record<string, string> = {};
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(files, walkFiles(join(dir, e.name), rel));
    else files[rel] = readFileSync(join(dir, e.name), "utf8");
  }
  return files;
}

export interface KitDiff {
  added: string[];
  deleted: string[];
  modified: string[];
}

export function diffKit(expectedDir: string, actualDir: string): KitDiff {
  const expected = walkFiles(expectedDir);
  const actual = walkFiles(actualDir);
  const diff: KitDiff = { added: [], deleted: [], modified: [] };
  for (const [rel, content] of Object.entries(expected)) {
    const other = actual[rel];
    if (other === undefined) diff.deleted.push(rel);
    else if (other !== content) diff.modified.push(rel);
  }
  for (const rel of Object.keys(actual)) if (!(rel in expected)) diff.added.push(rel);
  return diff;
}

function fail(message: string): never {
  console.error(`gen-kits: ${message}`);
  process.exit(1);
}

function main(): void {
  const args = process.argv.slice(2);
  let out: string | null = null;
  let check = false;
  let force = false;
  let only: HostId | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") out = resolve(args[++i] ?? fail("--out requires a directory"));
    else if (args[i] === "--check") check = true;
    else if (args[i] === "--force") force = true;
    else if (args[i] === "--only") {
      const id = args[++i] as HostId;
      if (!HOST_IDS.includes(id)) fail(`--only must be one of ${HOST_IDS.join(", ")}`);
      only = id;
    } else fail(`unknown argument '${args[i]}'`);
  }

  const hosts = only ? [only] : [...HOST_IDS];
  const staging = mkdtempSync(join(ROOT, ".tmp-gen-kits-"));
  try {
    for (const host of hosts) generateKit(host, staging);

    if (check) {
      let drift = false;
      for (const host of hosts) {
        const diff = diffKit(join(staging, host), join(KITS, host));
        const count = diff.added.length + diff.deleted.length + diff.modified.length;
        if (count === 0) {
          console.log(`gen-kits: ${host} up to date`);
          continue;
        }
        drift = true;
        console.log(`gen-kits: ${host} drift (${count} files):`);
        for (const rel of diff.modified) console.log(`  M ${rel}`);
        for (const rel of diff.deleted) console.log(`  + generated-but-missing: ${rel}`);
        for (const rel of diff.added) console.log(`  - not-in-canonical-output: ${rel}`);
      }
      if (drift) process.exit(1);
      return;
    }

    if (out) {
      for (const host of hosts) cpSync(join(staging, host), join(out, host), { recursive: true });
      console.log(`gen-kits: wrote ${hosts.join(", ")} to ${out}`);
      return;
    }
    // In-place: swap each generated kit over the checked-in one. Refuse to
    // silently destroy files the generator doesn't know about — a checked-in
    // file absent from canonical output would vanish without a trace.
    for (const host of hosts) {
      const target = join(KITS, host);
      const diff = diffKit(join(staging, host), target);
      if (diff.added.length > 0 && !force) {
        console.error(`gen-kits: ${host} has ${diff.added.length} file(s) not in canonical output:`);
        for (const rel of diff.added) console.error(`  ? ${rel}`);
        fail(
          `refusing to overwrite ${host} — add the files to the generator's transform table, delete them, or pass --force`,
        );
      }
      rmSync(target, { recursive: true, force: true });
      cpSync(join(staging, host), target, { recursive: true });
    }
    console.log(`gen-kits: regenerated ${hosts.join(", ")} from kits/_core`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) main();
