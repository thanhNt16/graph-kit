import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRunEvent, createRun, mutateRun, resumeRun } from "../../src/runtime/store.js";
import type { Run } from "../../src/schemas.js";
import { writeJsonAtomic } from "../../src/shared/files.js";

let project: string;
let run: Run;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "gk-store-"));
  run = {
    run_id: "run-1",
    template: "demo",
    harness: "claude",
    status: "running",
    current_nodes: ["alpha"],
    pending_items: [],
    in_flight: {},
    iteration: 0,
    failures: 0,
    completed_deterministic_nodes: [],
    verdict: null,
  };
});

async function listCheckpoints(): Promise<string[]> {
  return (await readdir(join(project, ".graphkit", "runs", "run-1", "checkpoints"))).sort();
}

describe("run layout and mutation", () => {
  test("createRun writes layout with 0000-start checkpoint", async () => {
    await createRun(project, run, { count: 0 }, []);
    const dir = join(project, ".graphkit", "runs", "run-1");
    for (const file of ["run.json", "state.json", "leases.json", "events.jsonl"]) {
      await expect(readFile(join(dir, file), "utf8")).resolves.toBeDefined();
    }
    expect(await listCheckpoints()).toEqual(["0000-start.json"]);
    const parentFiles = await readdir(dir);
    expect(parentFiles.some((f) => f.includes(".tmp-") || f.includes(".event-tmp-"))).toBe(false);
  });

  test("mutateRun appends one event, one immutable checkpoint, and provenance", async () => {
    await createRun(project, run, { count: 0 }, []);
    const result = await mutateRun(project, "run-1", (docs) => {
      docs.state.count = (docs.state.count as number) + 1;
      docs.run.iteration += 1;
      return {
        documents: docs,
        event: { type: "dispatch", node: "alpha", actor: "tester", timestamp: "2026-01-01T00:00:00.000Z" },
      };
    });
    expect(result.event?.checkpoint).toBe("0001-alpha");
    expect(result.documents.state.count).toBe(1);

    const events = (await readFile(join(project, ".graphkit", "runs", "run-1", "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toHaveLength(1);
    expect(events[0].checkpoint).toBe("0001-alpha");
    expect(events[0].run_id).toBe("run-1");

    const checkpoints = await listCheckpoints();
    expect(checkpoints).toEqual(["0000-start.json", "0001-alpha.json"]);
    const cp = JSON.parse(
      await readFile(join(project, ".graphkit", "runs", "run-1", "checkpoints", "0001-alpha.json"), "utf8"),
    );
    expect(cp.provenance).toEqual({
      run_id: "run-1",
      node: "alpha",
      lease: undefined,
      actor: "tester",
      timestamp: "2026-01-01T00:00:00.000Z",
      checkpoint: "0001-alpha",
    });
    expect(cp.run.iteration).toBe(1);
    expect(cp.state).toEqual({ count: 1 });
    // immutable: rewrites of an existing checkpoint must refuse
    const cpPath = join(project, ".graphkit", "runs", "run-1", "checkpoints", "0001-alpha.json");
    await expect(writeJsonAtomic(cpPath, {}, true)).rejects.toThrow();
  });

  test("mutateRun second transition increments checkpoint number", async () => {
    await createRun(project, run, {}, []);
    await mutateRun(project, "run-1", (d) => ({
      documents: d,
      event: { type: "dispatch", timestamp: "2026-01-01T00:00:00.000Z" },
    }));
    await mutateRun(project, "run-1", (d) => ({
      documents: d,
      event: { type: "submit", timestamp: "2026-01-01T00:00:00.000Z" },
    }));
    expect(await listCheckpoints()).toEqual(["0000-start.json", "0001-alpha.json", "0002-alpha.json"]);
  });

  test("appendRunEvent appends a whole event line", async () => {
    await createRun(project, run, {}, []);
    await appendRunEvent(project, "run-1", {
      type: "error",
      run_id: "run-1",
      node: "alpha",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const lines = (await readFile(join(project, ".graphkit", "runs", "run-1", "events.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).type).toBe("error");
  });
});

describe("crash resume", () => {
  test("resumeRun restores newest valid checkpoint after corrupt state", async () => {
    await createRun(project, run, { count: 0 }, []);
    await mutateRun(project, "run-1", (d) => {
      d.state.count = 1;
      d.run.current_nodes = ["beta"];
      return { documents: d, event: { type: "dispatch", node: "beta", timestamp: "2026-01-01T00:00:00.000Z" } };
    });
    await mutateRun(project, "run-1", (d) => {
      d.state.count = 2;
      d.run.current_nodes = ["gamma"];
      d.run.iteration = 2;
      return { documents: d, event: { type: "submit", node: "gamma", timestamp: "2026-01-01T00:00:00.000Z" } };
    });
    // corrupt live state.json
    await writeFile(join(project, ".graphkit", "runs", "run-1", "state.json"), "{ not json");
    const restored = await resumeRun(project, "run-1");
    expect(restored.state).toEqual({ count: 2 });
    expect(restored.run.current_nodes).toEqual(["gamma"]);
    expect(restored.run.iteration).toBe(2);
  });

  test("resumeRun restores oldest checkpoint when newest corrupt", async () => {
    await createRun(project, run, { count: 0 }, []);
    await mutateRun(project, "run-1", (d) => {
      d.state.count = 1;
      return { documents: d, event: { type: "dispatch", timestamp: "2026-01-01T00:00:00.000Z" } };
    });
    const dir = join(project, ".graphkit", "runs", "run-1", "checkpoints");
    const corrupt = join(dir, "0001-alpha.json");
    await writeFile(corrupt, "{ not json");
    await writeFile(join(project, ".graphkit", "runs", "run-1", "state.json"), "{ not json");
    const restored = await resumeRun(project, "run-1");
    // falls back to 0000-start
    expect(restored.state).toEqual({ count: 0 });
  });
});

describe("createRun idempotency and checkpoint indexing", () => {
  test("second createRun refuses and leaves all live docs and checkpoint unchanged", async () => {
    await createRun(project, run, { count: 0 }, []);
    const dir = join(project, ".graphkit", "runs", "run-1");
    const before = {
      run: await readFile(join(dir, "run.json"), "utf8"),
      state: await readFile(join(dir, "state.json"), "utf8"),
      leases: await readFile(join(dir, "leases.json"), "utf8"),
      start: await readFile(join(dir, "checkpoints", "0000-start.json"), "utf8"),
    };
    await expect(createRun(project, { ...run, run_id: "run-1" }, { count: 99 }, [])).rejects.toThrow("MODIFIED_TARGET");
    expect(await readFile(join(dir, "run.json"), "utf8")).toBe(before.run);
    expect(await readFile(join(dir, "state.json"), "utf8")).toBe(before.state);
    expect(await readFile(join(dir, "state.json"), "utf8")).not.toContain("99");
    expect(await readFile(join(dir, "checkpoints", "0000-start.json"), "utf8")).toBe(before.start);
    expect(await listCheckpoints()).toEqual(["0000-start.json"]);
  });

  test("next checkpoint number is max index + 1, not file count", async () => {
    await createRun(project, run, {}, []);
    await mutateRun(project, "run-1", (d) => ({
      documents: d,
      event: { type: "dispatch", timestamp: "2026-01-01T00:00:00.000Z" },
    }));
    // inject a gap: manually add checkpoint 0005
    const dir = join(project, ".graphkit", "runs", "run-1", "checkpoints");
    const fake = JSON.parse(await readFile(join(dir, "0001-alpha.json"), "utf8"));
    fake.provenance.checkpoint = "0005-alpha";
    await writeJsonAtomic(join(dir, "0005-alpha.json"), fake, false);
    await mutateRun(project, "run-1", (d) => ({
      documents: d,
      event: { type: "submit", timestamp: "2026-01-01T00:00:00.000Z" },
    }));
    const names = await listCheckpoints();
    expect(names).toContain("0005-alpha.json");
    expect(names).toContain("0006-alpha.json");
    expect(names).not.toContain("0002-alpha.json");
  });

  test("concurrent resume rewrites serialize under the directory lock", async () => {
    await createRun(project, run, { count: 0 }, []);
    await mutateRun(project, "run-1", (d) => {
      d.state.count = 1;
      return { documents: d, event: { type: "dispatch", timestamp: "2026-01-01T00:00:00.000Z" } };
    });
    // corrupt live state so each resumeRun must rewrite from checkpoint
    await writeFile(join(project, ".graphkit", "runs", "run-1", "state.json"), "{ not json");
    // Two concurrent resume rewrites must serialize; both succeed and neither
    // observes a torn half-written document.
    const results = await Promise.all([resumeRun(project, "run-1"), resumeRun(project, "run-1")]);
    for (const docs of results) expect(docs.run).toBeDefined();
    // final state.json is valid JSON written by the last lock holder
    const finalState = JSON.parse(await readFile(join(project, ".graphkit", "runs", "run-1", "state.json"), "utf8"));
    expect(finalState).toEqual({ count: 1 });
  });
});
