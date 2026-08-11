// M4 parity instrument: measures CBM direct vs CBM-via-MCP vs gk CLI search latency
// Exit 0 always — prints SKIP if CBM_CMD unset

import { spawn } from "node:child_process";
import { resolve } from "node:path";

const CBM_CMD = process.env.CBM_CMD;
const FIXTURES = resolve(import.meta.dir, "..", "eval", "cbm", "code-fixtures");
const PATTERN = "sampleAdd";
const _GK_BIN = resolve(import.meta.dir, "..", "node_modules", ".bin", "gk") || "bun";
const GK_ENTRY = resolve(import.meta.dir, "..", "src", "cli", "index.ts");

if (!CBM_CMD) {
  console.log("CBM not configured — skipping");
  process.exit(0);
}

async function timeMs(label: string, fn: () => Promise<void>): Promise<number> {
  const start = performance.now();
  await fn();
  const ms = performance.now() - start;
  console.log(`  ${label}: ${ms.toFixed(1)}ms`);
  return ms;
}

// (a) CBM direct — spawn binary, send one search_graph JSON-RPC, read response
function cbmDirect(): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn(CBM_CMD, [], { stdio: ["pipe", "pipe", "pipe"] });
    const id = 1;
    const msg = `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "search_graph",
        arguments: { pattern: PATTERN, project: "cbm-parity", path_filter: FIXTURES },
      },
    })}\n`;

    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        rej(new Error("timeout"));
      }
    }, 30_000);

    child.stdout.on("data", (data: Buffer) => {
      const str = data.toString();
      try {
        const parsed = JSON.parse(str.trim());
        if (parsed.id === id && !settled) {
          settled = true;
          clearTimeout(timeout);
          child.kill();
          res();
        }
      } catch {}
    });

    child.stderr.on("data", () => {});
    child.on("exit", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        res();
      }
    });

    child.stdin.write(msg);
  });
}

// (b) CBM via MCP — import createCbmClient from source
async function cbmViaMcp(): Promise<void> {
  const { createCbmClient } = await import("../src/cbm/client.js");
  const client = createCbmClient();
  await client.call("search_graph", {
    pattern: PATTERN,
    project: "cbm-parity",
    path_filter: FIXTURES,
  });
  await client.close();
}

// (c) gk CLI subprocess
function gkCliSearch(): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn("bun", ["run", GK_ENTRY, "graph", "search", PATTERN, "cbm-parity"], {
      stdio: "pipe",
      env: { ...process.env, CBM_CMD },
    });
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        rej(new Error("timeout"));
      }
    }, 30_000);
    child.on("exit", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        res();
      }
    });
    child.stderr.on("data", () => {});
  });
}

async function main() {
  console.log("CBM Parity Instrument");
  console.log(`  CBM_CMD: ${CBM_CMD}`);
  console.log(`  pattern: ${PATTERN}`);
  console.log();

  const a = await timeMs("(a) CBM direct", cbmDirect);
  const b = await timeMs("(b) CBM-via-MCP", cbmViaMcp);
  const c = await timeMs("(c) gk CLI", gkCliSearch);

  console.log();
  console.log(`Ratios — c/a: ${(c / a).toFixed(2)}x  b/a: ${(b / a).toFixed(2)}x`);

  if (c <= 1.5 * a) {
    console.log("PASS (CLI overhead within 1.5x direct)");
  } else {
    console.log("FAIL (CLI overhead exceeds 1.5x direct)");
  }

  if (b > 1.5 * a) {
    console.log("RENEGOTIATE (MCP transport ceiling hit)");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
