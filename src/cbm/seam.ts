// The one CBM dependency-injection seam + client lifecycle. graph.ts and
// memory.ts each used to keep their own factory variable + create→call→close
// try/finally copy; the seam now lives next to the client it injects.
import { type CbmClient, createCbmClient } from "./client.js";
import { indexProject } from "./index.js";

let _clientFactory: () => CbmClient = () => createCbmClient();
let _indexProjectFn: typeof indexProject = indexProject;

/** @internal test seam — inject client factory + index implementation. */
export function _injectCbm(opts: { clientFactory?: () => CbmClient; indexProject?: typeof indexProject }) {
  if (opts.clientFactory) _clientFactory = opts.clientFactory;
  if (opts.indexProject) _indexProjectFn = opts.indexProject;
}

/** @internal test seam — restore real implementations. */
export function _resetCbm() {
  _clientFactory = () => createCbmClient();
  _indexProjectFn = indexProject;
}

/** The seam's current index implementation (tests may have swapped it). */
export function getIndexProjectFn(): typeof indexProject {
  return _indexProjectFn;
}

/**
 * Own the create→call→close lifecycle so a thrown call can't leak the spawned
 * CBM child process.
 */
export async function withCbmClient<T>(fn: (client: CbmClient) => Promise<T>): Promise<T> {
  const client = _clientFactory();
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}
