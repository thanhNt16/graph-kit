import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CAC } from "cac";
import { GraphKitError } from "../../errors.js";
import { type FactoryConfig, loadFactoryConfig, validateFactory } from "../../factory/config.js";
import { runFactory, tick, type Providers, type TickDeps } from "../../factory/dispatcher.js";
import { listJournals, loadJournal, saveJournal } from "../../factory/journal.js";
import { runLane } from "../../factory/lane-runner.js";
import { LocalBoardProvider, LocalVCSProvider, LocalWorkspace } from "../../factory/providers/local.js";
import { leafUsageFor, subcommandsFor } from "../command-registry.js";
import { emit, fail, ok } from "../output.js";

/** Root of the installed/bundled factory assets (templates/factory/). */
function factoryAssetsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const up of [join(here, "..", "..", ".."), join(here, "..", ".."), join(here, "..", "..", "..", "..")]) {
    const p = join(up, "templates", "factory");
    if (existsSync(join(p, "factory.yaml"))) return p;
  }
  throw new GraphKitError("FACTORY_CONFIG", "templates/factory assets not found in this gk install");
}

function guardExtensionPath(cwd: string): string {
  // sync-omp materializes kit extensions under .omp/extensions/
  const candidates = [
    join(cwd, ".omp", "extensions", "gk-factory-guard.ts"),
    join(factoryAssetsDir(), "..", "..", "kits", "_core", "extensions", "gk-factory-guard.ts"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new GraphKitError("FACTORY_CONFIG", "gk-factory-guard.ts extension not found (run gk kit install or gk factory init)");
}

function providers(cwd: string, cfg: FactoryConfig): Providers {
  if (cfg.board.provider !== "local" || cfg.vcs.provider !== "local") {
    throw new GraphKitError("FACTORY_PROVIDER", `provider ${cfg.board.provider}/${cfg.vcs.provider} not yet implemented (v1: local only)`);
  }
  const boardDir = cfg.board.local?.dir ? join(cwd, cfg.board.local.dir) : LocalBoardProvider.defaultDir(cwd);
  return {
    board: new LocalBoardProvider(boardDir),
    vcs: new LocalVCSProvider(cwd),
    workspace: new LocalWorkspace(cwd, cfg.vcs.branch_prefix),
  };
}

function tickDeps(cwd: string, cfg: FactoryConfig): TickDeps {
  const assets = factoryAssetsDir();
  return {
    workspace: providers(cwd, cfg).workspace,
    board: providers(cwd, cfg).board,
    guardExtension: guardExtensionPath(cwd),
    agentFragment: (agent: string) => {
      const p = join(assets, "agents", `${agent}.md`);
      return existsSync(p) ? readFileSync(p, "utf8") : `You are ${agent}.`;
    },
  };
}

/** `gk factory` — board-driven agent production line. */
export function registerFactoryCommand(cli: CAC) {
  cli
    .command("factory [subcommand] [args...]", `Software factory\nSubcommands: ${subcommandsFor("factory")}`)
    .option("--json", "JSON output")
    .option("--force", "init: overwrite existing .omp/factory.yaml")
    .option("--title <t>", "card add: title")
    .option("--body <md>", "card add: description")
    .option("--max-ticks <n>", "run: tick cap (default 20)")
    .example(leafUsageFor("factory"))
    .action(async (subcommand, args, opts) => {
      const cwd = process.cwd();
      const json = Boolean(opts?.json);
      if (!subcommand) {
        console.log(`gk factory — software-factory commands\n\nUsage:\n  gk factory <subcommand> [args...]\n\nSubcommands:\n${leafUsageFor("factory")}`);
        return;
      }
      const arg0 = Array.isArray(args) ? args[0] : args;
      const arg1 = Array.isArray(args) ? args[1] : undefined;
      try {
        if (subcommand === "init") {
          const dest = join(cwd, ".omp", "factory.yaml");
          if (existsSync(dest) && !opts?.force) {
            emit(fail("FACTORY_CONFIG", ".omp/factory.yaml exists (use --force)"));
            return;
          }
          const assets = factoryAssetsDir();
          mkdirSync(join(cwd, ".omp"), { recursive: true });
          writeFileSync(dest, readFileSync(join(assets, "factory.yaml"), "utf8"));
          // Materialize the skill pack + agent prompts + guard extension under .omp/
          for (const kind of ["skills", "agents"] as const) {
            const src = join(assets, kind);
            const destDir = join(cwd, ".omp", kind === "agents" ? "agents" : "skills");
            for (const entry of existsSync(src) ? readdirSync(src) : []) {
              const from = join(src, entry);
              const to = join(destDir, entry);
              mkdirSync(dirname(to), { recursive: true });
              if (kind === "skills") {
                mkdirSync(to, { recursive: true });
                writeFileSync(join(to, "SKILL.md"), readFileSync(join(from, "SKILL.md"), "utf8"));
              } else {
                writeFileSync(to, readFileSync(from, "utf8"));
              }
            }
          }
          mkdirSync(join(cwd, ".omp", "extensions"), { recursive: true });
          writeFileSync(
            join(cwd, ".omp", "extensions", "gk-factory-guard.ts"),
            readFileSync(join(assets, "..", "..", "kits", "_core", "extensions", "gk-factory-guard.ts"), "utf8"),
          );
          emit(ok({ written: ".omp/factory.yaml", skills: ".omp/skills/", agents: ".omp/agents/", guard: ".omp/extensions/gk-factory-guard.ts" }));
          return;
        }

        if (subcommand === "validate") {
          const cfg = loadFactoryConfig(cwd);
          const findings = validateFactory(cwd, cfg);
          if (json) {
            emit(ok({ valid: !findings.some((f) => f.severity !== "warn"), findings }));
          } else if (findings.length === 0) {
            console.log("factory config valid");
          } else {
            for (const f of findings) console.log(`[${f.check}]${f.severity === "warn" ? " (warn)" : ""} ${f.path}: ${f.message}`);
          }
          return;
        }

        if (subcommand === "card") {
          const board = new LocalBoardProvider(LocalBoardProvider.defaultDir(cwd));
          if (arg0 === "add") {
            const title = opts?.title ? String(opts.title) : undefined;
            if (!title) {
              emit(fail("MISSING_ARG", "factory card add requires --title"));
              return;
            }
            const cfg = loadFactoryConfig(cwd);
            const card = board.create({
              key: `#${Math.floor(Math.random() * 9000 + 1000)}`,
              title,
              description: opts?.body ? String(opts.body) : "",
              labels: cfg.board.intake_label ? [cfg.board.intake_label] : [],
            });
            emit(ok(card));
            return;
          }
          if (arg0 === "list") {
            const lanes = ["ready", "building", "qa", "review", "blocked", "done"] as const;
            const out: Record<string, unknown[]> = {};
            for (const l of lanes) out[l] = await board.getCardsInLane(l);
            emit(ok(out));
            return;
          }
          emit(fail("MISSING_ARG", `factory card ${String(arg0)} unknown (add|list)`));
          return;
        }

        const cfg = loadFactoryConfig(cwd);
        const prov = providers(cwd, cfg);
        const deps = tickDeps(cwd, cfg);

        if (subcommand === "tick") {
          const r = await tick(cwd, cfg, prov, deps);
          emit(ok(r));
          return;
        }
        if (subcommand === "run") {
          const r = await runFactory(cwd, cfg, prov, deps, Number(opts?.["max-ticks"] ?? 20));
          emit(ok({ ticks: r.length, last: r[r.length - 1] }));
          return;
        }
        if (subcommand === "lane") {
          if (!arg0 || !arg1) {
            emit(fail("MISSING_ARG", "factory lane requires <card> <lane>"));
            return;
          }
          const card = await prov.board.getCard(String(arg0));
          const j = loadJournal(cwd, String(arg0));
          if (!card || !j) {
            emit(fail("FACTORY_CONFIG", `no card/journal for ${String(arg0)}`));
            return;
          }
          const outcome = await runLane(cwd, cfg, card, j, arg1 as Parameters<typeof runLane>[4], deps);
          emit(ok(outcome));
          return;
        }
        if (subcommand === "status") {
          const journals = listJournals(cwd);
          emit(ok({ cards: journals }));
          return;
        }
        if (subcommand === "halt") {
          if (!arg0) {
            emit(fail("MISSING_ARG", "factory halt requires <card>"));
            return;
          }
          await prov.board.addLabel(String(arg0), cfg.board.halt_label);
          const j = loadJournal(cwd, String(arg0));
          if (j) {
            j.phase = "parked";
            saveJournal(cwd, j);
          }
          emit(ok({ halted: arg0 }));
          return;
        }
        if (subcommand === "resume") {
          if (!arg0) {
            emit(fail("MISSING_ARG", "factory resume requires <card>"));
            return;
          }
          await prov.board.removeLabel(String(arg0), cfg.board.halt_label);
          const j = loadJournal(cwd, String(arg0));
          if (j) {
            j.phase = "claimed";
            saveJournal(cwd, j);
          }
          emit(ok({ resumed: arg0 }));
          return;
        }
        emit(fail("MISSING_ARG", `unknown factory subcommand "${subcommand}"`, { known: subcommandsFor("factory") }));
      } catch (e) {
        if (e instanceof GraphKitError) {
          emit(fail(e.code, e.message, e.details ?? {}));
          return;
        }
        throw e;
      }
    });
}
