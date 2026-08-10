import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CAC } from "cac";
import YAML from "yaml";
import { type CbmClient, createCbmClient } from "../../cbm/client.js";
import { indexProject } from "../../cbm/index.js";
import { fail, ok } from "../output.js";

// ponytail: DI seam for tests — avoids spawning the real CBM server.
let _cbmClientFactory: () => CbmClient = () => createCbmClient();
let _indexProjectFn: typeof indexProject = indexProject;
/** @internal test seam — inject client + index implementations. */
export function _setMemoryCbmSeam(opts: { clientFactory?: () => CbmClient; indexProject?: typeof indexProject }) {
  if (opts.clientFactory) _cbmClientFactory = opts.clientFactory;
  if (opts.indexProject) _indexProjectFn = opts.indexProject;
}
/** @internal test seam — restore real implementations. */
export function _resetMemoryCbmSeam() {
  _cbmClientFactory = () => createCbmClient();
  _indexProjectFn = indexProject;
}

// project precedence: --project flag → graph.yaml topology_config.memory.project → default
function resolveProject(cwd: string, override?: string): string {
  if (override) return override;
  try {
    const graph = YAML.parse(readFileSync(join(cwd, "graph.yaml"), "utf-8"));
    const fromCfg = graph?.topology_config?.memory?.project;
    if (typeof fromCfg === "string" && fromCfg) return fromCfg;
  } catch {
    /* no graph.yaml — fall back to default */
  }
  return "graph-kit-memory";
}

export async function indexMemory(cwd: string, projectOverride?: string) {
  const project = resolveProject(cwd, projectOverride);
  const memDir = join(cwd, ".graphkit", "memory");
  mkdirSync(memDir, { recursive: true });

  const client = _cbmClientFactory();
  try {
    await _indexProjectFn(client, { repoPath: memDir, name: project });
  } finally {
    await client.close();
  }

  const watermark = new Date().toISOString();
  writeFileSync(join(cwd, ".graphkit", ".last-index"), watermark);
  const dirty = join(cwd, ".graphkit", ".memory-dirty");
  if (existsSync(dirty)) unlinkSync(dirty);
  return { project, indexed: true, watermark };
}

export function registerMemoryCommands(cli: CAC) {
  cli
    .command("memory index", "Index .graphkit/memory/ into the CBM memory project")
    .option("--project <project>", "CBM project name (default: graph.yaml memory.project or graph-kit-memory)")
    .option("--json", "JSON output")
    .action(async (opts) => {
      try {
        const result = await indexMemory(process.cwd(), opts.project);
        console.log(JSON.stringify(ok(result)));
      } catch (e) {
        console.log(JSON.stringify(fail("CBM_UNAVAILABLE", String(e))));
        process.exit(1);
      }
    });
}
