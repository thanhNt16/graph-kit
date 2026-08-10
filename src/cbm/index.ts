import type { CbmClient } from "./client.js";

export interface IndexResult {
  project: string;
  indexed: boolean;
  nodes?: number;
}

export async function indexProject(
  client: CbmClient,
  opts: { repoPath: string; name?: string; mode?: "fast" | "moderate" | "full" },
): Promise<IndexResult> {
  const params: Record<string, unknown> = { repo_path: opts.repoPath };
  if (opts.name) params.name = opts.name;
  if (opts.mode) params.mode = opts.mode;

  await client.call("index_repository", params);
  return { project: opts.name ?? opts.repoPath, indexed: true };
}
