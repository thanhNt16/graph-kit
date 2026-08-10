import { join } from "node:path";
import { runGolden } from "./replay.js";

const r = runGolden(join(import.meta.dir, "..", "..", "eval", "golden"));
console.log(JSON.stringify(r, null, 2));
process.exit(r.results.every((x) => x.pass) ? 0 : 1);
