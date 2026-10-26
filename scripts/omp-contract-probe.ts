#!/usr/bin/env bun
/**
 * omp contract probe — records the verified CLI/event contract for the
 * software-factory spec as JSONL fixtures under tests/fixtures/factory/omp/.
 *
 * Runs against any configured omp model; a zero-cost deterministic model is
 * recommended (see CONTRACT.md for the `mock` provider setup used to produce
 * the committed fixtures).
 *
 * Usage: bun run scripts/omp-contract-probe.ts [--model mock/mock-model]
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(import.meta.dir, "..", "tests", "fixtures", "factory", "omp");
const MODEL = process.argv.includes("--model")
	? process.argv[process.argv.indexOf("--model") + 1]
	: "mock/mock-model";

interface Probe {
	name: string;
	args: string[];
	prompt: string;
	env?: Record<string, string>;
}

const POLICY = JSON.stringify({
	worktree: `${OUT}/wt`,
	owns: [] as string[],
	deny_bash: ["gh\\s+pr\\s+(merge|close)", "git\\s+push", "git\\s+checkout\\s+(main|master)"],
	log_path: `${OUT}/guard.log`,
});

const probes: Probe[] = [
	{ name: "p1-json-stream", args: ["-p", "--no-session", "--mode", "json"], prompt: "say OK" },
	{
		name: "p2-append-system-prompt",
		args: ["-p", "--no-session", "--mode", "json", "--append-system-prompt", "x".repeat(6000)],
		prompt: "say OK",
	},
	{
		name: "p3-unknown-skill",
		args: ["-p", "--no-session", "--mode", "json", "--skills", "factory-build,does-not-exist"],
		prompt: "say OK",
	},
	{
		name: "p4-tools-exclude",
		args: ["-p", "--no-session", "--mode", "json", "--tools", "read,grep"],
		prompt: "write a file",
	},
	{
		name: "p5-guard-bash-block",
		args: ["-p", "--no-session", "--mode", "json", "-e", `${OUT}/guard.ts`],
		prompt: "merge the PR",
		env: { GK_FACTORY_POLICY: POLICY },
	},
];

function run(p: Probe): { code: number } {
	const proc = Bun.spawnSync(["omp", ...p.args, "--model", MODEL], {
		stdin: Buffer.from(`${p.prompt}\n`),
		env: { ...process.env, ...p.env },
	});
	const out = proc.stdout.toString();
	const err = proc.stderr.toString();
	writeFileSync(join(OUT, `${p.name}.jsonl`), out);
	writeFileSync(join(OUT, `${p.name}.stderr`), err);
	return { code: proc.exitCode ?? -1 };
}

mkdirSync(OUT, { recursive: true });
const summary: Record<string, number> = {};
for (const p of probes) {
	summary[p.name] = run(p).code;
}
appendFileSync(join(OUT, "probe-summary.json"), `${JSON.stringify({ model: MODEL, exits: summary })}\n`);
console.log(JSON.stringify({ model: MODEL, exits: summary }));
