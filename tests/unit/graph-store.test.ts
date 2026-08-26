import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Graph } from "../../src/compiler/validate.js";
import { GraphKitError } from "../../src/errors.js";
import {
  getActiveGraphId,
  listSessionGraphs,
  loadActiveGraph,
  saveSessionGraph,
  setActiveGraphId,
} from "../../src/store/index.js";

const TEST_DIR = join(import.meta.dir, ".tmp-store-test");

beforeEach(() => {
  mkdirSync(join(TEST_DIR, ".graphkit", "graphs"), { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("Session Graph Store", () => {
  const sampleGraph: Graph = {
    apiVersion: "graphkit.dev/v2",
    kind: "Graph",
    metadata: { name: "my-task", description: "Audit auth" },
    topology: "custom",
    nodes: { a: { agent: "coder", objective: "fix" } },
  };

  it("saves graph and sets active", () => {
    const { id } = saveSessionGraph(sampleGraph, "my-task", TEST_DIR);
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}-my-task/);
    setActiveGraphId(id, TEST_DIR);
    expect(getActiveGraphId(TEST_DIR)).toBe(id);

    const loaded = loadActiveGraph(TEST_DIR);
    expect(loaded.id).toBe(id);
    expect(loaded.graph.metadata.name).toBe("my-task");
  });

  it("lists saved session graphs", () => {
    saveSessionGraph(sampleGraph, "task-1", TEST_DIR);
    saveSessionGraph(sampleGraph, "task-2", TEST_DIR);
    const list = listSessionGraphs(TEST_DIR);
    expect(list.length).toBe(2);
    expect(list[0]?.name).toBe("my-task");
    expect(list[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("suffixes ids on same-date slug collision (-2, -3)", () => {
    const first = saveSessionGraph(sampleGraph, "collide", TEST_DIR);
    const second = saveSessionGraph(sampleGraph, "collide", TEST_DIR);
    const third = saveSessionGraph(sampleGraph, "collide", TEST_DIR);
    expect(first.id).toMatch(/^\d{4}-\d{2}-\d{2}-collide$/);
    expect(second.id).toMatch(/^\d{4}-\d{2}-\d{2}-collide-2$/);
    expect(third.id).toMatch(/^\d{4}-\d{2}-\d{2}-collide-3$/);
    expect(first.id).not.toBe(second.id);
    expect(second.id).not.toBe(third.id);
    expect(listSessionGraphs(TEST_DIR).length).toBe(3);
  });

  it("throws GRAPHKIT_NOT_INITIALIZED without .graphkit dir", () => {
    const bare = join(TEST_DIR, "bare-dir");
    mkdirSync(bare, { recursive: true });
    expect(() => getActiveGraphId(bare)).toThrow();
    expect(() => loadActiveGraph(bare)).toThrow();
    expect(() => saveSessionGraph(sampleGraph, "x", bare)).toThrow();

    try {
      loadActiveGraph(bare);
    } catch (e) {
      if (e instanceof GraphKitError) {
        expect(e.code).toBe("GRAPHKIT_NOT_INITIALIZED");
      } else {
        throw e;
      }
    }
  });

  it("throws ACTIVE_POINTER_DANGLING with available ids when active names a missing file", () => {
    const saved = saveSessionGraph(sampleGraph, "real", TEST_DIR);
    const dangling = "2026-08-26-does-not-exist";
    writeFileSync(join(TEST_DIR, ".graphkit", "active"), `${dangling}\n`, "utf-8");
    expect(getActiveGraphId(TEST_DIR)).toBe(dangling);

    try {
      loadActiveGraph(TEST_DIR);
      expect.unreachable("loadActiveGraph must throw");
    } catch (e) {
      if (e instanceof GraphKitError) {
        expect(e.code).toBe("ACTIVE_POINTER_DANGLING");
        const available = e.details?.available;
        expect(Array.isArray(available)).toBe(true);
        if (Array.isArray(available)) {
          expect(available).toContain(saved.id);
        }
      } else {
        throw e;
      }
    }
  });

  it("setActiveGraphId refuses unknown ids", () => {
    try {
      setActiveGraphId("2026-08-26-ghost", TEST_DIR);
      expect.unreachable("setActiveGraphId must throw");
    } catch (e) {
      if (e instanceof GraphKitError) {
        expect(e.code).toBe("GRAPH_NOT_FOUND");
      } else {
        throw e;
      }
    }
  });
});
