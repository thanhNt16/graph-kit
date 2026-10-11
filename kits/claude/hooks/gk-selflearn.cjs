#!/usr/bin/env node
// gk-selflearn — self-learning host hook (AutoHarness port, daemon-free:
// every event shells out to a `gk selflearn` leaf and exits; nothing
// long-running). Fail-open: any error exits 0 so the host never blocks.
//
//   session-start  → inject "## Learned patterns" index + last-run one-liner
//   pre-tool       → +1 per tool call; when reflect_due, instruct the session
//                    to run `gk selflearn reflect`
//   session-end    → slice the transcript window into the session's episode
//                    file (idempotent — the byte watermark makes Stop after
//                    SessionEnd a no-op), then promote staged intents
//
// Usage: gk-selflearn.cjs <session-start|pre-tool|session-end>
const { execFileSync } = require("node:child_process");

const gk = (args, cwd) =>
  execFileSync("gk", ["selflearn", ...args, "--json"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 });

const parse = (out) => {
  try {
    const env = JSON.parse(out);
    return env.status === "ok" ? env.data : null;
  } catch {
    return null;
  }
};

const readEvent = () => {
  try {
    return JSON.parse(require("node:fs").readFileSync(0, "utf-8"));
  } catch {
    return {};
  }
};

function main() {
  const mode = process.argv[2] || "session-start";
  const event = readEvent();
  const cwd = event.cwd || process.cwd();
  const session = event.session_id || "default";

  if (mode === "session-start") {
    const data = parse(gk(["context"], cwd));
    const context = data?.context;
    if (context) {
      // Claude Code SessionStart contract: additionalContext is injected.
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }));
    }
    return;
  }

  if (mode === "pre-tool") {
    const data = parse(gk(["tick", "--session", session], cwd));
    if (data?.reflect_due) {
      // Exit 0 with output: the session sees this as hook feedback and runs
      // `gk selflearn reflect`, which materializes the gk-reflector bundle.
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            additionalContext: `[gk selflearn] Reflection cadence reached (${data.n} tool calls). Run \`gk selflearn reflect --session ${session}\` to materialize the reflector bundle, then dispatch the gk-reflector agent on it.`,
          },
        }),
      );
    }
    return;
  }

  if (mode === "session-end") {
    const transcript = event.transcript_path;
    if (transcript) gk(["capture", "--session", session, "--transcript", transcript], cwd);
    const data = parse(gk(["promote", "--session", session], cwd));
    if (data && (data.landed || data.rejected)) {
      process.stdout.write(
        JSON.stringify({ systemMessage: `gk selflearn: landed ${data.landed}, rejected ${data.rejected}` }),
      );
    }
    return;
  }
}

try {
  main();
} catch {
  /* fail-open */
}
process.exit(0);
