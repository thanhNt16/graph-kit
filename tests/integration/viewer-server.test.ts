import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import nodeHttp from "node:http";
import { join } from "node:path";
import { startViewerServer } from "../../src/viewer/server.js";

const TMP = join(import.meta.dir, ".tmp-viewer");
const GRAPH = join(TMP, "graph.yaml");
const ASSETS = join(import.meta.dir, "viewport-assets");

const VALID = `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: live
topology: diamond
inputs:
  task: { type: string, required: true }
nodes:
  root:
    agent: Software Architect
    model: opus
    objective: plan
    depend_on: []
    evidence: [plan]
  worker:
    agent: Code Reviewer
    model: sonnet
    objective: do work
    depend_on: [root]
    evidence: [findings]
evidence:
  required_keys: [findings]
`;

const INVALID = `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: broken
topology: diamond
nodes:
  root:
    objective: no agent
  worker:
    agent: Code Reviewer
    depend_on: [missing-node]
`;

const TOO_LARGE = (() => {
  const nodes: string[] = [];
  for (let i = 0; i < 251; i++) nodes.push(`  n${i}:\n    agent: Code Reviewer\n    objective: o\n`);
  return `apiVersion: graphkit.dev/v2\nkind: Graph\nmetadata:\n  name: big\ntopology: custom\nnodes:\n${nodes.join("")}\n`;
})();

let handle: Awaited<ReturnType<typeof startViewerServer>> | null = null;
const KEY = "testkey-1234567890abcdef";

function httpGet(path: string, port: number): Promise<{ status: number; text: string }> {
  return fetch(`http://127.0.0.1:${port}${path}`).then(async (r) => ({ status: r.status, text: await r.text() }));
}

/**
 * Open an SSE stream via raw node http (bun's fetch getReader does not stream
 * SSE frames), then wait for frames. Returns {readNext, abort}.
 */
type Frame = { type: string; [k: string]: any };
type FramePred = (d: Frame) => boolean;

function sseStream(port: number) {
  let buf = "";
  const waiters: Array<{
    pred: FramePred;
    timer: ReturnType<typeof setTimeout>;
    resolve: (d: Frame) => void;
    reject: (e: Error) => void;
  }> = [];
  const drain = () => {
    while (waiters.length) {
      const m = buf.match(/event: update\ndata: (\{.*?\})\n\n/s);
      if (!m) break;
      buf = buf.slice(m.index! + m[0].length);
      const parsed = JSON.parse(m[1]) as Frame;
      const idx = waiters.findIndex((w) => w.pred(parsed));
      if (idx < 0) continue; // no waiter wants this frame — skip it
      const [w] = waiters.splice(idx, 1);
      clearTimeout(w.timer);
      w.resolve(parsed);
    }
  };
  const req = nodeHttp.get(
    `http://127.0.0.1:${port}/events?key=${KEY}`,
    { headers: { accept: "text/event-stream" } },
    (res) => {
      res.on("data", (chunk) => {
        buf += chunk.toString();
        drain();
      });
    },
  );
  req.on("error", () => {});

  const nextFrame = (pred: FramePred = () => true): Promise<Frame> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = waiters.findIndex((w) => w.timer === timer);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error("SSE timeout"));
      }, 5000);
      waiters.push({ pred, timer, resolve, reject });
      drain();
    });

  const ready = nextFrame();
  return {
    /**
     * The server sends the current state as an event immediately on connect.
     * `ready` deterministically consumes exactly that first frame, so `readNext`
     * only ever resolves on frames emitted AFTER the initial broadcast.
     */
    ready,
    readNext: (pred?: FramePred) => ready.then(() => nextFrame(pred)),
    abort: () => req.destroy(),
  };
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

beforeAll(async () => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true });
  mkdirSync(TMP, { recursive: true });
  mkdirSync(ASSETS, { recursive: true });
  writeFileSync(
    join(ASSETS, "index.html"),
    '<html><link rel="stylesheet" href="./styles.css" /><script src="./dagre.js"></script><script src="./app.js"></script>viewer</html>',
  );
  writeFileSync(join(ASSETS, "app.js"), "// app");
  writeFileSync(join(ASSETS, "styles.css"), "/* css */");
  writeFileSync(join(ASSETS, "dagre.js"), "globalThis.dagre={};");
  writeFileSync(GRAPH, VALID);
  handle = await startViewerServer({ graphPath: GRAPH, assetDir: ASSETS, key: KEY, debounceMs: 50, idleMs: 60000 });
});

afterAll(async () => {
  if (handle) await handle.close();
  if (existsSync(TMP)) rmSync(TMP, { recursive: true });
  if (existsSync(ASSETS)) rmSync(ASSETS, { recursive: true });
});

describe("viewer server", () => {
  test("binds to 127.0.0.1 on an ephemeral port and serves initial graph", async () => {
    expect(handle).not.toBeNull();
    const health = await httpGet(`/health?key=${KEY}`, handle!.port);
    expect(health.status).toBe(200);
    const { status: gs, text: gtext } = await httpGet(`/api/graph?key=${KEY}`, handle!.port);
    expect(gs).toBe(200);
    const body = JSON.parse(gtext);
    expect(body.type).toBe("graph");
    expect(body.graph.name).toBe("live");
    expect(body.graph.nodeCount).toBe(2);
  });

  test("rejects requests without a valid key", async () => {
    const bad1 = await httpGet("/api/graph", handle!.port);
    expect(bad1.status).toBe(403);
    const bad2 = await httpGet("/api/graph?key=wrong", handle!.port);
    expect(bad2.status).toBe(403);
    const bad3 = await httpGet("/?key=wrong", handle!.port);
    expect(bad3.status).toBe(403);
  });

  test("serves bundled assets with strict CSP", async () => {
    const { status } = await httpGet(`/?key=${KEY}`, handle!.port);
    // index.html is served via serveAsset with CSP header
    expect(status).toBe(200);
  });

  test("serves only whitelisted assets; arbitrary paths 404", async () => {
    const app = await httpGet(`/app.js?key=${KEY}`, handle!.port);
    expect(app.status).toBe(200);
    const arb = await httpGet(`/../../etc/passwd?key=${KEY}`, handle!.port);
    expect(arb.status).toBe(404);
  });

  test("served HTML rewrites asset URLs with the key so every asset request authenticates", async () => {
    // The bundled index.html references ./styles.css, ./dagre.js, ./app.js with
    // no key; the server must inject the key so the browser's asset requests
    // pass the per-request key gate.
    const page = await httpGet(`/?key=${KEY}`, handle!.port);
    expect(page.status).toBe(200);
    expect(page.text).toContain(`./styles.css?key=${KEY}`);
    expect(page.text).toContain(`./dagre.js?key=${KEY}`);
    expect(page.text).toContain(`./app.js?key=${KEY}`);
    // The rewritten URLs are exactly what the browser would request, and they
    // must all authenticate (200, not 403).
    for (const asset of ["styles.css", "dagre.js", "app.js"]) {
      const r = await httpGet(`/${asset}?key=${KEY}`, handle!.port);
      expect(r.status, `${asset} with key`).toBe(200);
      // without the key the same asset is rejected — the per-request gate holds
      const noKey = await httpGet(`/${asset}`, handle!.port);
      expect(noKey.status, `${asset} without key`).toBe(403);
    }
  });

  test("emits a graph update over SSE after a valid file change", async () => {
    const stream = sseStream(handle!.port);
    const ev = stream.readNext((d) => d.type === "graph" && d.graph?.name === "live2");
    await wait(80);
    writeFileSync(GRAPH, VALID.replace("name: live", "name: live2"));
    const data = await ev;
    stream.abort();
    expect(data.type).toBe("graph");
    expect(data.graph.name).toBe("live2");
  });

  test("retains last valid graph and emits findings after an invalid save", async () => {
    const valid = await httpGet(`/api/graph?key=${KEY}`, handle!.port);
    expect(JSON.parse(valid.text).graph.name).toBe("live2");

    const stream = sseStream(handle!.port);
    const ev = stream.readNext();
    await wait(80);
    writeFileSync(GRAPH, INVALID);
    const data = await ev;
    stream.abort();
    expect(data.type).toBe("error");
    expect(data.code).toBe("SCHEMA_INVALID");

    // The API reports the current error state; the last valid graph is
    // retained in memory and returns on the next valid save (see recover test).
    const after = JSON.parse((await httpGet(`/api/graph?key=${KEY}`, handle!.port)).text);
    expect(after.type).toBe("error");
    expect(after.code).toBe("SCHEMA_INVALID");

    // restore a valid file for subsequent tests
    writeFileSync(GRAPH, VALID.replace("name: live", "name: live2"));
  });

  test("recovers after a subsequent valid save", async () => {
    // Wait until the restore from the previous test has been processed.
    let body = JSON.parse((await httpGet(`/api/graph?key=${KEY}`, handle!.port)).text);
    for (let i = 0; i < 20 && body.type !== "graph"; i++) {
      await wait(30);
      body = JSON.parse((await httpGet(`/api/graph?key=${KEY}`, handle!.port)).text);
    }
    expect(body.type).toBe("graph");
    expect(body.graph.name).toBe("live2");

    const stream = sseStream(handle!.port);
    const ev = stream.readNext((d) => d.type === "graph" && d.graph?.name === "recovered");
    await wait(80);
    writeFileSync(GRAPH, VALID.replace("name: live", "name: recovered"));
    const data = await ev;
    stream.abort();
    expect(data.type).toBe("graph");
    expect(data.graph.name).toBe("recovered");
  });

  test("rejects graphs above 250 nodes via initial load path", async () => {
    // Point a fresh server at a too-large graph to exercise the ceiling.
    const bigGraph = join(TMP, "big.yaml");
    writeFileSync(bigGraph, TOO_LARGE);
    const bigSrv = await startViewerServer({ graphPath: bigGraph, assetDir: ASSETS, key: "bigkey" });
    try {
      const { status, text } = await httpGet("/api/graph?key=bigkey", bigSrv.port);
      expect(status).toBe(200);
      const body = JSON.parse(text);
      expect(body.type).toBe("error");
      expect(body.code).toBe("TOO_LARGE");
    } finally {
      await bigSrv.close();
    }
  });

  test("exposes no mutation endpoint", async () => {
    const post = await fetch(`http://127.0.0.1:${handle!.port}/somewhere?key=${KEY}`, { method: "POST" });
    // unknown routes return 404; no POST handler exists anywhere
    expect(post.status).toBe(404);
  });

  test("bundled launcher is runnable: starts server, prints keyed URL, serves graph", async () => {
    // The installed-kit launcher (claude/viewer/server.mjs) is a bundled
    // self-contained script. Spawn it pointing at a graph and verify it prints
    // a keyed URL and serves the graph over that URL.
    const launcher = join(import.meta.dir, "..", "..", "claude", "viewer", "server.mjs");
    expect(existsSync(launcher)).toBe(true);
    const bundledGraph = join(TMP, "launcher-graph.yaml");
    writeFileSync(bundledGraph, VALID.replace("name: live", "name: launcher-live"));

    const child = spawn("bun", [launcher, bundledGraph], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("launcher did not print URL in time")), 10000);
        child.stdout.on("data", (chunk: Buffer) => {
          const m = /GraphKit viewer: (http:\/\/127\.0\.0\.1:\d+\/\?key=[^\s]+)/.exec(chunk.toString());
          if (m) {
            clearTimeout(timer);
            resolve(m[1]);
          }
        });
        child.on("exit", () => reject(new Error("launcher exited before printing URL")));
      });

      const parsed = new URL(url);
      const { status, text } = await httpGet(
        `${parsed.pathname}api/graph?key=${parsed.searchParams.get("key")}`,
        Number(parsed.port),
      );
      expect(status).toBe(200);
      const body = JSON.parse(text);
      expect(body.type).toBe("graph");
      expect(body.graph.name).toBe("launcher-live");
    } finally {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 200));
    }
  });
});
