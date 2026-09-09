import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CAC } from "cac";
import YAML from "yaml";
import { GraphKitError } from "../../errors.js";
import {
  activeRun,
  activeRunGraph,
  appendAdvisor,
  appendNode,
  endRun,
  readAdvisorEvents,
  readRunMeta,
  readTrace,
  startRun,
} from "../../memory/ledger.js";
import { resumeRun } from "../../memory/resume.js";
import { GraphSchema } from "../../schemas/graph.schema.js";
import { subcommandsFor } from "../command-registry.js";
import { fail, ok } from "../output.js";

function errCode(e: unknown): { code: string; message: string; details?: Record<string, unknown> } {
  // GraphKitError carries its code (and optional details) — use them directly.
  // Anything else keeps the legacy behavior: an "CODE: msg" prefix extracted
  // from the message, else the generic RUN_ERROR fallback.
  if (e instanceof GraphKitError) return { code: e.code, message: e.message, details: e.details };
  const message = String((e as Error)?.message ?? e);
  const code = message.match(/^([A-Z_]+):/)?.[1] ?? "RUN_ERROR";
  return { code, message };
}

// Human default for `gk run status`: a short progress summary for the active
// run (id, graph, round, node/evidence progress, verdict chain). `--json`
// prints the machine envelope instead. Fail envelopes stay JSON on stdout.
function renderRunStatus(
  cwd: string,
  data: { active: string | null; advisor_events: number; resumes_chain: string[] },
): string {
  if (!data.active) return "no active run";
  const id = basename(data.active);
  let graph = "unknown";
  let started = "unknown";
  try {
    const meta = readRunMeta(cwd, id);
    graph = meta.graph;
    started = meta.started_at;
  } catch {
    /* legacy meta without graph tracking — render what we know */
  }
  const trace = readTrace(cwd, id);
  const okNodes = trace.filter((t) => t.status === "ok").length;
  const failedNodes = trace.filter((t) => t.status === "fail").length;
  const waves = new Set(trace.map((t) => t.wave).filter((w) => w != null));
  const round = waves.size ? Math.max(...waves) + 1 : 0;
  const evidence = new Set(trace.flatMap((t) => t.evidence));
  return [
    `run: ${id}`,
    `graph: ${graph}`,
    `started: ${started}`,
    `round: ${round} · nodes: ${okNodes} ok / ${failedNodes} failed / ${trace.length} traced · evidence: ${evidence.size} keys`,
    `advisor events: ${data.advisor_events}`,
    `verdict chain: ${data.resumes_chain.join(" <- ")}`,
  ].join("\n");
}

export function registerRunCommands(cli: CAC) {
  cli
    .command("run [subcommand] [args...]", `Run ledger commands\nSubcommands: ${subcommandsFor("run")}`)
    .option("--graph <path>", "graph.yaml path (default: ./graph.yaml)")
    .option("--status <status>", "node: ok|fail — end: merged|blocked|failed")
    .option("--advisor-fired <round>", "record advisor firing for a node")
    .option("--streak <n>", "advisor failure streak")
    .option("--wave <n>", "wave index")
    .option("--agent <agent>", "agent id")
    .option("--model <model>", "model tier")
    .option("--evidence <keys>", "comma-separated evidence keys")
    .option("--duration-ms <n>", "node duration in ms")
    .option("--notes <text>", "free-text note")
    .option("--json", "JSON output")
    .option("--from-node <id>", "resume: redo this node + dependents")
    .option("--dry-run", "resume: preview without writing")
    .option("--force", "resume: override graph drift guard")
    .action((subcommand, args, opts) => {
      const cwd = process.cwd();
      if (!subcommand) {
        console.log(
          `gk run — run ledger commands\n\nUsage:\n  gk run <subcommand> [args...]\n\nSubcommands: ${subcommandsFor("run")}`,
        );
        return;
      }
      try {
        if (subcommand === "start") {
          console.log(JSON.stringify(ok(startRun(cwd, opts.graph ?? join(cwd, "graph.yaml")))));
          return;
        }
        if (subcommand === "node") {
          const node = Array.isArray(args) ? args[0] : args;
          if (!node) {
            console.log(JSON.stringify(fail("MISSING_ARG", "node requires a node id")));
            return;
          }
          // Advisor-fired mode needs no --status: the firing itself is the trace line.
          if (opts.advisorFired != null) {
            const round = Number(opts.advisorFired);
            // tier is derived from the graph's node.advisor.model (spec §5)
            if (!Number.isInteger(round) || round < 1) {
              console.log(JSON.stringify(fail("BAD_ADVISOR", "--advisor-fired requires an integer round >= 1")));
              return;
            }
            const streak = opts.streak == null ? null : Number(opts.streak);
            if (streak !== null && (!Number.isInteger(streak) || streak < 1)) {
              console.log(JSON.stringify(fail("BAD_ADVISOR", "--streak requires an integer >= 1")));
              return;
            }
            // Tier source: the ACTIVE RUN's recorded graph (what the run actually executes) so a
            // run started with `--graph sub/x.yaml` needs no repeated flag; explicit --graph wins,
            // falling back to cwd/graph.yaml for legacy runs without a recorded path.
            const graphPath = opts.graph ?? activeRunGraph(cwd) ?? join(cwd, "graph.yaml");
            const parsed = GraphSchema.safeParse(YAML.parse(readFileSync(graphPath, "utf-8")));
            const advisor = parsed.success ? parsed.data.nodes[String(node)]?.advisor : undefined;
            if (!advisor) {
              console.log(JSON.stringify(fail("BAD_ADVISOR", `node "${node}" has no advisor config in ${graphPath}`)));
              return;
            }
            console.log(
              JSON.stringify(
                ok(
                  appendAdvisor(cwd, {
                    node: String(node),
                    round,
                    tier: advisor.model,
                    streak,
                  }),
                ),
              ),
            );
            return;
          }
          if (opts.status !== "ok" && opts.status !== "fail") {
            console.log(JSON.stringify(fail("BAD_STATUS", "node requires --status ok|fail")));
            return;
          }
          const result = appendNode(cwd, {
            node: String(node),
            wave: opts.wave == null ? null : Number(opts.wave),
            agent: opts.agent ?? null,
            model: opts.model ?? null,
            status: opts.status,
            evidence: opts.evidence
              ? String(opts.evidence)
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
              : [],
            duration_ms: opts.durationMs == null ? null : Number(opts.durationMs),
            notes: opts.notes ?? null,
          });
          console.log(JSON.stringify(ok(result)));
          return;
        }
        if (subcommand === "end") {
          const status = opts.status ?? "merged";
          if (!["merged", "blocked", "failed"].includes(status)) {
            console.log(JSON.stringify(fail("BAD_STATUS", "end requires --status merged|blocked|failed")));
            return;
          }
          console.log(JSON.stringify(ok(endRun(cwd, status))));
          return;
        }
        if (subcommand === "resume") {
          const target = Array.isArray(args) ? args[0] : args;
          if (!target) {
            process.exitCode = 1;
            console.log(JSON.stringify(fail("MISSING_ARG", "resume requires a run id")));
            return;
          }
          try {
            console.log(
              JSON.stringify(
                ok(resumeRun(cwd, String(target), { fromNode: opts.fromNode, dryRun: opts.dryRun, force: opts.force })),
              ),
            );
          } catch (e) {
            process.exitCode = 1;
            const { code, message, details } = errCode(e);
            console.log(JSON.stringify(fail(code, message, details)));
          }
          return;
        }
        if (subcommand === "status") {
          const dir = activeRun(cwd);
          const advisor_events = dir ? readAdvisorEvents(cwd, basename(dir)).length : 0;
          const chain: string[] = [];
          let cursor: string | null = dir ? basename(dir) : null;
          const guard = new Set<string>();
          while (cursor && !guard.has(cursor)) {
            guard.add(cursor);
            chain.push(cursor);
            try {
              cursor = readRunMeta(cwd, cursor).resumes ?? null;
            } catch {
              cursor = null;
            }
          }
          const data = { active: dir, advisor_events, resumes_chain: chain };
          if (opts.json) {
            console.log(JSON.stringify(ok(data)));
          } else {
            console.log(renderRunStatus(cwd, data));
          }
          return;
        }
        console.log(
          JSON.stringify(
            fail("UNKNOWN_RUN_SUBCOMMAND", `Unknown run subcommand "${subcommand}"`, {
              available: subcommandsFor("run").split(" "),
            }),
          ),
        );
      } catch (e) {
        const { code, message, details } = errCode(e);
        console.log(JSON.stringify(fail(code, message, details)));
      }
    });
}
