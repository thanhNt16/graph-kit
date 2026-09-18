// Baseline runner for graph-kit efficiency ground truth.
// Arm A: grep/glob (rg commands recorded in benchmark.jsonl)
// Arm B: gk (CBM knowledge-graph search via gk's own src/cbm/client.ts)
// Metric: tokens_used + (wall_clock_seconds * 100) + (wrong_answers * 10000)
// tokens_used is approximated as ceil(total_retrieved_bytes / 4) — retrieval payload
// the agent would have to read. Wrong answers are scored by a substring-recall check
// of the ground-truth anchor symbols against the retrieved payload.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const REPO = import.meta.dir;
const PROJECT = "Users-harrynguyen-Desktop-graph-engineering-graph-kit";
const arm = process.argv[2];

const rows = readFileSync(`${REPO}/benchmark.jsonl`, "utf-8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

// Anchor symbols per question — retrieval must surface these to count as correct.
const ANCHORS: Record<string, string[]> = {
  q01: ["validateGraph", "validate.ts"],
  q02: ["validateGraph", "graph.ts"],
  q03: ["loadGraph", "GraphSchema"],
  q04: ["compileGraph", "emitter.ts"],
  q05: ["resolveTopologyConfig"],
  q06: ["EFFECTIVE_TOPOLOGY", "custom"],
  q07: ["createCbmClient", "codebase-memory-mcp"],
  q08: ["createCbmClient"],
  q09: ["indexProject", "index_repository"],
  q10: ["appendMetric", "metrics"],
  q11: ["runGolden", "replay"],
  q12: ["scoreWorkProduct", "rubrics"],
  q13: ["actRScore", "use_count"],
  q14: ["_GK_BIN"],
  q15: ["computeLevel", "fanOutConnector"],
  q16: ["TOPOLOGY_NAMES", "getTopologyConfigKeys"],
  q17: ["kitSourceDir", "GK_KIT_DIR"],
  q18: ["installKit"],
  q19: ["search_graph", "pattern"],
  q20: ["actionWaves", "depend_on"],
};

function score(id: string, payload: string): boolean {
  return (ANCHORS[id] ?? []).every((a) => payload.includes(a));
}

async function main() {
  let bytes = 0;
  let wrong = 0;
  const t0 = performance.now();

  if (arm === "grep") {
    for (const r of rows) {
      let out = "";
      try {
        out = execSync(r.command, { cwd: REPO, encoding: "utf-8", shell: "/bin/bash" });
      } catch (e: any) {
        out = (e.stdout ?? "") + (e.stderr ?? "");
      }
      bytes += Buffer.byteLength(out);
      if (!score(r.id, out)) {
        wrong++;
        console.error(`MISS ${r.id}`);
      }
    }
  } else if (arm === "gk") {
    // Routed arm: full question text through the product dispatch (src/cbm/route.ts),
    // same path as `gk graph ask`. The frozen EVAL (questions + anchors + score)
    // is untouched; this arm IS the system under test.
    const { createCbmClient } = await import(`${REPO}/src/cbm/client.ts`);
    const { routeAndRetrieve } = await import(`${REPO}/src/cbm/route.ts`);
    const client = createCbmClient({ cmd: "/Users/harrynguyen/.local/bin/codebase-memory-mcp", args: [] });
    for (const r of rows) {
      let out = "";
      try {
        const res = await routeAndRetrieve(client, r.question, PROJECT);
        out = JSON.stringify(res);
      } catch (e: any) {
        out = String(e);
      }
      bytes += Buffer.byteLength(out);
      if (!score(r.id, out)) {
        wrong++;
        console.error(`MISS ${r.id}`);
      }
    }
    await client.close();
  } else {
    console.error("usage: run_baseline.ts <grep|gk>");
    process.exit(2);
  }

  const wall = (performance.now() - t0) / 1000;
  const tokens = Math.ceil(bytes / 4);
  const metric = tokens + wall * 100 + wrong * 10000;
  console.log(
    JSON.stringify({
      arm,
      questions: rows.length,
      bytes,
      tokens,
      wall_seconds: +wall.toFixed(3),
      wrong_answers: wrong,
      metric: Math.round(metric),
      peak_rss_mb: +(process.memoryUsage().rss / 1048576).toFixed(1),
    }),
  );
}

main();
