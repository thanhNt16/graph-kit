// Shared CBM test seam — one module so graph.ts and memory.ts cannot drift.
// Injects fakes for the CBM client factory and indexProject, avoiding a real
// CBM server spawn in tests. Restore via resetCbmSeam.
import { type CbmClient, createCbmClient } from "../cbm/client.js";
import { indexProject } from "../cbm/index.js";

// ponytail: module-level mutable state — DI seams resist const-style; tests reset after each case.
let _clientFactory: () => CbmClient = () => createCbmClient();
let _indexProjectFn: typeof indexProject = indexProject;

/** @internal test seam — inject client + index implementations. */
export function setCbmSeam(opts: { clientFactory?: () => CbmClient; indexProject?: typeof indexProject }) {
  if (opts.clientFactory) _clientFactory = opts.clientFactory;
  if (opts.indexProject) _indexProjectFn = opts.indexProject;
}

/** @internal test seam — restore real implementations. */
export function resetCbmSeam() {
  _clientFactory = () => createCbmClient();
  _indexProjectFn = indexProject;
}

export function seamClientFactory(): () => CbmClient {
  return _clientFactory;
}

export function seamIndexProject(): typeof indexProject {
  return _indexProjectFn;
}
