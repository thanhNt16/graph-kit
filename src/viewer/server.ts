import { randomBytes } from "node:crypto";
import { type Stats, statSync, unwatchFile, watch, watchFile } from "node:fs";

type StatsListener = (curr: Stats, prev: Stats) => void;

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, normalize, resolve, sep } from "node:path";
import YAML from "yaml";
import { GraphKitError } from "../errors.js";
import { GraphSchema } from "../schemas/graph.schema.js";
import { type Graph, normalizeGraph, type ViewerGraph } from "./normalize.js";
import { injectAssetKeys } from "./view.js";

export interface ViewerServerOptions {
  graphPath: string;
  /** Where the bundled browser assets (index.html, app.js, styles.css) live. */
  assetDir: string;
  /** Milliseconds of quiet before reacting to a file change. */
  debounceMs?: number;
  /** Milliseconds of no SSE activity before the server shuts down. */
  idleMs?: number;
  /** Optional external key (tests). Defaults to a fresh 24-byte random key. */
  key?: string;
}

const DEBOUNCE_MS = 200;
const IDLE_MS = 4 * 60 * 60 * 1000; // four hours

/** Parse + schema-validate a graph file. Throws GraphKitError on failure. */
export async function loadAndNormalize(graphPath: string): Promise<ViewerGraph> {
  const raw = await readFile(graphPath, "utf-8");
  let doc: unknown;
  try {
    doc = YAML.parse(raw);
  } catch (e) {
    throw new GraphKitError("YAML_INVALID", `Invalid YAML: ${(e as Error).message}`);
  }
  const parsed = GraphSchema.safeParse(doc);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue.path.join(".");
    throw new GraphKitError("SCHEMA_INVALID", issue.message, { path });
  }
  const res = normalizeGraph(parsed.data as Graph);
  if (!res.ok) {
    throw new GraphKitError(res.code, res.message);
  }
  return res.graph;
}

/** Extract the trailing path segment from a URL, dropping a leading slash. */
function routeOf(url: string = "/"): string {
  const pathname = url.split("?")[0];
  return pathname.replace(/^\/+/, "");
}

// Keys match routeOf() output (no leading slash).
const ASSETS: Record<string, { file: string; type: string }> = {
  "": { file: "index.html", type: "text/html; charset=utf-8" },
  index: { file: "index.html", type: "text/html; charset=utf-8" },
  "index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "dagre.js": { file: "dagre.js", type: "text/javascript; charset=utf-8" },
  "styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
};

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

/**
 * Launch the read-only local viewer server.
 * - Binds 127.0.0.1 on an ephemeral port.
 * - Requires a key on HTML, asset, and SSE requests.
 * - Watches only the selected graph file (debounced), live-updates over SSE.
 */
export async function startViewerServer(opts: ViewerServerOptions): Promise<{
  server: Server;
  url: string;
  key: string;
  port: number;
  close: () => Promise<void>;
}> {
  const graphPath = resolve(opts.graphPath);
  const assetDir = resolve(opts.assetDir);
  const key = opts.key ?? randomBytes(24).toString("hex");
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  const idleMs = opts.idleMs ?? IDLE_MS;

  let current: ViewerGraph | null = null;
  let lastError: GraphKitError | null = null;

  // Initial load — a failure surfaces as a structured error payload (the server
  // still starts and keeps watching for a correction).
  try {
    current = await loadAndNormalize(graphPath);
  } catch (e) {
    lastError = e instanceof GraphKitError ? e : new GraphKitError("LOAD_ERROR", String(e));
  }

  const sseClients = new Set<ServerResponse>();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let dirWatcher: ReturnType<typeof watch> | null = null;
  let lastMtimeMs = 0;
  let closed = false;

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      void close();
    }, idleMs);
    if (typeof idleTimer.unref === "function") idleTimer.unref();
  };

  const broadcast = () => {
    const payload = lastError
      ? { type: "error", code: lastError.code, message: lastError.message, path: lastError.details?.path }
      : { type: "graph", graph: current };
    const frame = `event: update\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of sseClients) res.write(frame);
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    resetIdle();
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const route = routeOf(url.pathname);

    // Key gate — every request must carry the access key as a query param.
    if (url.searchParams.get("key") !== key) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("forbidden");
      return;
    }

    // Read-only initial graph payload (no mutation endpoint exists).
    if (route === "api/graph") {
      const body = lastError
        ? { type: "error", code: lastError.code, message: lastError.message, path: lastError.details?.path }
        : { type: "graph", graph: current };
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-security-policy": CSP });
      res.end(JSON.stringify(body));
      return;
    }
    if (route === "health") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }

    // SSE endpoint.
    if (route === "events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("retry: 2000\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      broadcast();
      return;
    }

    // Asset endpoints — only whitelisted bundled files.
    const asset = ASSETS[route];
    if (asset) {
      const target = normalize(`${assetDir}${sep}${asset.file}`);
      const safe = target.startsWith(normalize(assetDir) + sep);
      readFile(safe ? target : "")
        .then((buf) => {
          let body = buf;
          // The HTML references bundled assets without a key; rewrite them to
          // carry the key so the browser's asset requests authenticate against
          // the per-request key gate (every asset request is still gated).
          if (asset.file === "index.html") {
            body = Buffer.from(injectAssetKeys(Buffer.from(buf).toString("utf-8"), key));
          }
          res.writeHead(200, {
            "content-type": asset.type,
            "content-security-policy": CSP,
            "cache-control": "no-store",
          });
          res.end(body);
        })
        .catch(() => {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("not found");
        });
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  });

  // Debounced reload of the one selected graph file.
  const reload = async () => {
    try {
      current = await loadAndNormalize(graphPath);
      lastError = null;
    } catch (e) {
      lastError = e instanceof GraphKitError ? e : new GraphKitError("LOAD_ERROR", String(e));
    }
    broadcast();
  };
  const scheduleReload = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void reload();
    }, debounceMs);
  };
  const mtimeListener: StatsListener = (curr) => {
    const mtime = curr.mtimeMs;
    if (mtime !== lastMtimeMs) {
      lastMtimeMs = mtime;
      scheduleReload();
    }
  };

  // Primary: low-latency dir watch (may miss rapid in-place writes under load).
  dirWatcher = watch(dirname(graphPath), (_event, filename) => {
    if (filename && resolve(dirname(graphPath), String(filename)) !== graphPath) return;
    scheduleReload();
  });
  // Fallback: mtime polling guarantees the change is never missed even if the
  // dir watcher drops an event (e.g. parallel process contention on macOS).
  watchFile(graphPath, { interval: 100 }, mtimeListener);
  try {
    lastMtimeMs = statSync(graphPath).mtimeMs;
  } catch {
    /* graph may not exist yet */
  }

  const close = async () => {
    if (closed) return;
    closed = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (debounceTimer) clearTimeout(debounceTimer);
    if (dirWatcher) dirWatcher.close();
    unwatchFile(graphPath, mtimeListener);
    for (const res of sseClients) res.end();
    sseClients.clear();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  };

  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    server,
    url: `http://127.0.0.1:${port}/?key=${key}`,
    key,
    port,
    close: () => close(),
  };
}
