import { basename, join } from "node:path";
import type { CAC } from "cac";
import { loadGraph } from "../../compiler/loader.js";
import { GraphKitError } from "../../errors.js";
import {
  activeRun,
  activeRunGraph,
  appendAdvisor,
  appendNode,
  deriveRound,
  endRun,
  listRunIds,
  readAdvisorEvents,
  readRunIndex,
  readRunMeta,
  readTrace,
  readTraceStats,
  startRun,
} from "../../memory/ledger.js";
import { resumeRun } from "../../memory/resume.js";
import { subcommandHelpFor, subcommandsFor } from "../command-registry.js";
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
  const round = deriveRound(trace);
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

// resumes: chain walk from a run id back through its parents (guard against a
// hand-edited cycle).
function resumesChain(cwd: string, startId: string): string[] {
  const chain: string[] = [];
  let cursor: string | null = startId;
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
  return chain;
}

export function registerRunCommands(cli: CAC) {
  cli
    .command("run [subcommand] [args...]", `Run ledger commands\nSubcommands: ${subcommandsFor("run")}`)
    .example(subcommandHelpFor("run"))
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
          const started = startRun(cwd, opts.graph ?? join(cwd, "graph.yaml"));
          if (opts.json) {
            console.log(JSON.stringify(ok(started)));
          } else {
            console.log(
              `run ${started.id} started — record nodes with \`gk run node <node-id> --status ok\`, end with \`gk run end\``,
            );
          }
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
            // Shared loader: a broken graph.yaml surfaces as
            // GRAPH_FILE_NOT_FOUND/SCHEMA_INVALID via errCode, not as a
            // misleading BAD_ADVISOR for an unrelated read failure.
            const advisor = loadGraph(graphPath).nodes[String(node)]?.advisor;
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
          if (opts.json) {
            console.log(JSON.stringify(ok(result)));
          } else {
            console.log(`recorded ${result.node} on run ${result.run}`);
          }
          return;
        }
        if (subcommand === "end") {
          const status = opts.status ?? "merged";
          if (!["merged", "blocked", "failed"].includes(status)) {
            console.log(JSON.stringify(fail("BAD_STATUS", "end requires --status merged|blocked|failed")));
            return;
          }
          const summary = endRun(cwd, status);
          if (opts.json) {
            console.log(JSON.stringify(ok(summary)));
          } else {
            console.log(
              `run ${summary.id} ended: ${summary.status} — ${summary.node_count} node(s), ${summary.failures} failure(s); appended to .graphkit/runs/index.jsonl`,
            );
          }
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
        if (subcommand === "list") {
          // The front door for `gk run resume <id>`: index.jsonl only knows
          // ENDED runs, so dir-only runs (active / interrupted) are merged in
          // from listRunIds — readRunIndex and listRunIds both existed with no
          // CLI consumer before this.
          const indexed = readRunIndex(cwd);
          const byId = new Map(indexed.map((r) => [r.id, r]));
          const activeId = activeRun(cwd) ? basename(activeRun(cwd)!) : null;
          const runs = listRunIds(cwd)
            .reverse() // ids are timestamp-prefixed: lexical == chronological
            .map((id) => {
              const row = byId.get(id);
              if (row) {
                return {
                  id,
                  graph: row.graph,
                  started_at: row.started_at,
                  status: row.status as string,
                  nodes: row.node_count,
                };
              }
              let graph = "unknown";
              let started_at = "unknown";
              try {
                const meta = readRunMeta(cwd, id);
                graph = meta.graph;
                started_at = meta.started_at;
              } catch {
                /* legacy/litter dir without meta */
              }
              return {
                id,
                graph,
                started_at,
                status: id === activeId ? "running" : "interrupted",
                nodes: readTraceStats(cwd, id).lines.length,
              };
            });
          if (opts.json) {
            console.log(JSON.stringify(ok({ total: runs.length, runs })));
            return;
          }
          if (runs.length === 0) {
            console.log("no runs yet — start one with `gk run start`");
            return;
          }
          console.log(
            [
              `run ledger — ${runs.length} run(s), newest first`,
              ...runs.map(
                (r) =>
                  `  ${r.id}  ${r.status.padEnd(11)}  ${r.graph}  ${r.started_at}  nodes ${r.nodes}${
                    r.status === "interrupted" ? `  (resume: \`gk run resume ${r.id}\`)` : ""
                  }`,
              ),
            ].join("\n"),
          );
          return;
        }
        if (subcommand === "status") {
          const target = Array.isArray(args) ? args[0] : args;
          if (target) {
            // Any recorded run, not just the active one — renderRunStatus
            // already reads everything through the id.
            const id = String(target);
            try {
              readRunMeta(cwd, id);
            } catch {
              console.log(
                JSON.stringify(fail("RUN_NOT_FOUND", `no run "${id}" under ${join(cwd, ".graphkit", "runs")}`)),
              );
              process.exitCode = 1;
              return;
            }
            const dir = join(cwd, ".graphkit", "runs", id);
            const data = {
              active: dir,
              advisor_events: readAdvisorEvents(cwd, id).length,
              resumes_chain: resumesChain(cwd, id),
            };
            if (opts.json) {
              console.log(JSON.stringify(ok(data)));
            } else {
              console.log(renderRunStatus(cwd, data));
            }
            return;
          }
          const dir = activeRun(cwd);
          const advisor_events = dir ? readAdvisorEvents(cwd, basename(dir)).length : 0;
          const data = {
            active: dir,
            advisor_events,
            resumes_chain: dir ? resumesChain(cwd, basename(dir)) : [],
          };
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
