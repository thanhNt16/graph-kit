// REFLECT — the bundle materializer + the self-trigger.
// `gk selflearn reflect` clears the sticky reflect_due flag, produces the
// reflector's input bundle under `.graphkit/selflearn/bundles/` (episode
// window + prior-context digest + description index + format spec — exactly
// the reflector's stdin per autoharness), and emits the spawn instruction
// the host follows. gk-reflector is read-only by kit profile (Read/Grep/Glob)
// and can only stage; promote is the only writer.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { digest, readEpisodeTail } from "./capture.js";
import { SKILL_FORMAT_SPEC } from "./format-spec.js";
import { descriptionIndex } from "./session_index.js";
import {
  bundlesDir,
  checkSafeId,
  readWatermark,
  type SelflearnTarget,
  writeTextAtomic,
  writeWatermark,
} from "./state.js";

export interface ReflectBundle {
  bundle_path: string;
  manifest_path: string;
  transcript_path?: string;
  window_lines: number;
  digest_present: boolean;
}

export function reflect(
  cwd: string,
  opts: { session: string; transcript?: string; target: SelflearnTarget },
): ReflectBundle {
  const session = checkSafeId("session id", opts.session);
  const wm = readWatermark(cwd, session);
  const windowText = readEpisodeTail(cwd, session);
  const dig =
    opts.transcript && existsSync(opts.transcript) ? digest(opts.transcript, wm.first_offset || wm.offset) : "";
  const index = descriptionIndex(cwd, opts.target);

  const lines = [
    "# gk-reflector input (gk selflearn reflect)",
    "",
    "## Existing skill descriptions (compare first — update beats duplicate; describe the delta, not the object)",
    index,
    "",
    `## Prior context (digest — background only, NOT evidence; offset ${wm.first_offset || wm.offset})`,
    dig || "(none)",
    "",
    "## Episode window — the ONLY evidence source (quote it verbatim in intent evidence)",
    windowText || "(empty episode window — nothing to distill; emit no intents)",
    "",
    `## Format spec\n\n${SKILL_FORMAT_SPEC}`,
  ];

  const stamp = Date.now().toString(36);
  const bundle = join(bundlesDir(cwd), `reflect-${session}-${stamp}.md`);
  writeTextAtomic(bundle, lines.join("\n"));
  const manifest = join(bundlesDir(cwd), `reflect-${session}-${stamp}.manifest.json`);
  writeTextAtomic(
    manifest,
    JSON.stringify(
      {
        session,
        target: opts.target,
        bundle: bundle.slice(cwd.length + 1),
        transcript: opts.transcript ?? null,
        first_offset: wm.first_offset || wm.offset,
        window_lines: windowText ? windowText.split("\n").length : 0,
        digest_present: !!dig,
        at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  // Consume the flag — the trigger stays out of the way until the cadence
  // armed again (tick sets it; reflect clears it).
  if (wm.reflect_due) writeWatermark(cwd, session, { ...wm, reflect_due: false });
  return {
    bundle_path: bundle.slice(cwd.length + 1),
    manifest_path: manifest.slice(cwd.length + 1),
    transcript_path: opts.transcript,
    window_lines: windowText ? windowText.split("\n").length : 0,
    digest_present: !!dig,
  };
}
