// Shim: the `graph` implementation lives in the graph/ package (round-5 split:
// register.ts route table, cbm.ts CBM primitives, lifecycle.ts, render.ts).
// Back-compat re-exports keep the old import surface stable for sibling
// commands (gate/doctor/status/evidence) and tests.

export { _injectCbm as _setCbmSeam, _resetCbm as _resetCbmSeam } from "../../cbm/seam.js";
export { loadGraph } from "../../compiler/loader.js";
export { graphTemplate } from "../graph-templates.js";
export { GRAPH_ROUTES, registerGraphCommands } from "./graph/register.js";
