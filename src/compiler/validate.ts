import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import YAML from "yaml";
import type { Issue } from "../cli/diagnostics.js";
import { topoWaves } from "../cli/graph-waves.js";
import { agentDirsFor, agentFileName } from "../targets/registry.js";
import type { Graph } from "../schemas/graph.schema.js";

/** A semantic check result. Shape-compatible with the schema `Issue` envelope:
 *  check and severity ride along as extra fields on the same object. */
export interface Finding extends Issue {
  check: string;
  /** Absent or "error" blocks validate-dependent commands; "warn" is advisory. */
  severity?: "warn";
}

export const isBlocking = (f: Finding) => f.severity !== "warn";

export function validateGraph(graph: Graph, projectRoot: string): Finding[] {
  const findings: Finding[] = [];

  // 1. Agent binding: first installed host's agent directory wins (pi first).
  const agentDir = agentDirsFor(projectRoot).find(existsSync);
  const available = agentDir ? readdirSync(agentDir).map((f) => basename(f, ".md")) : [];

  // 0. Non-custom topologies require at least one node
  if (graph.topology !== "custom" && Object.keys(graph.nodes).length === 0) {
    findings.push({
      check: "zero-nodes",
      path: "nodes",
      message: `Graph with topology "${graph.topology}" must declare at least one node`,
    });
  }
  for (const [id, node] of Object.entries(graph.nodes)) {
    const expected = agentFileName(node.agent).replace(/\.md$/, "");
    if (agentDir && !available.includes(expected)) {
      findings.push({
        check: "agent-binding",
        path: `nodes.${id}.agent`,
        message: `Agent "${node.agent}" not found — looked for ${agentFileName(node.agent)} in ${agentDir}. Available: ${available.join(", ")}`,
      });
    }

    // 2. Refs exist on disk
    for (const ref of node.refs) {
      if (!existsSync(join(projectRoot, ref.path))) {
        findings.push({
          check: "refs-exist",
          path: `nodes.${id}.refs`,
          message: `Ref "${ref.path}" does not exist`,
        });
      }
    }

    if (node.loop?.enabled && !node.loop.stop_when) {
      findings.push({
        check: "loop-exit",
        path: `nodes.${id}.loop`,
        message: "Loop enabled but no stop_when declared",
      });
    }
  }
  // 4. Evidence keys must be portable basenames; gate maps them directly to files
  for (const key of graph.evidence.required_keys) {
    if (key.length === 0 || key === "." || key === ".." || /[\\/]/.test(key)) {
      findings.push({
        check: "evidence-key-path",
        path: "evidence.required_keys",
        message: `Evidence key "${key}" must be a non-empty basename without path separators`,
      });
    }
  }

  // 5. Evidence coverage: every required key must be produced by some node
  const produced = new Set(Object.values(graph.nodes).flatMap((n) => n.evidence));
  for (const key of graph.evidence.required_keys) {
    if (!produced.has(key)) {
      findings.push({
        check: "evidence-keys",
        path: "evidence.required_keys",
        message: `Required evidence key "${key}" is not produced by any node`,
      });
    }
  }

  // 5c. Duplicate required_keys entries (ADVISORY): the gate dedupes before
  // mapping keys to files, so a repeated entry is harmless — but it is almost
  // always a copy-paste artifact worth surfacing.
  const seenRequired = new Set<string>();
  for (const key of graph.evidence.required_keys) {
    if (seenRequired.has(key)) {
      findings.push({
        check: "duplicate-required-key",
        path: "evidence.required_keys",
        message: `Evidence key "${key}" is listed more than once in required_keys`,
        severity: "warn",
      });
    }
    seenRequired.add(key);
  }

  // 5d. Duplicate evidence producers (ADVISORY): the gate maps each key to a
  // single file (.graphkit/evidence/<key>.md) — two nodes writing the same key
  // in one wave race that file. Late re-stamps across waves are legitimate,
  // so this stays advisory.
  const producers = new Map<string, string[]>();
  for (const [id, node] of Object.entries(graph.nodes)) {
    for (const key of node.evidence) {
      const list = producers.get(key) ?? [];
      list.push(id);
      producers.set(key, list);
    }
  }
  // Declared fan-out shapes never race the gate file and stay silent:
  // (a) classify-and-act-family dispatch runs only the matching handler (else
  // the fallback), so writers listed exclusively under routes[].handler ∪
  // fallback are mutually exclusive; (b) a topology_config array naming the
  // family (refuters: [r1, r2], generators: [...], candidates: [...]); (c) a
  // declared sibling family — every producer hanging off the identical
  // non-empty depend_on list (custom worker-N scaffolds).
  const tc = (graph.topology_config ?? {}) as Record<string, unknown>;
  const routeWriters = new Set<string>(
    ((Array.isArray(tc.routes) ? tc.routes : []) as Array<{ handler?: unknown }>)
      .map((r) => (typeof r?.handler === "string" ? r.handler : ""))
      .concat(typeof tc.fallback === "string" ? tc.fallback : "")
      .filter(Boolean),
  );
  for (const [key, ids] of producers) {
    const routeExclusive = routeWriters.size > 0 && ids.every((id) => routeWriters.has(id));
    const familyDeps = JSON.stringify(graph.nodes[ids[0]]?.depend_on ?? []);
    const declaredFamily =
      (familyDeps !== "[]" && ids.every((id) => JSON.stringify(graph.nodes[id]?.depend_on ?? []) === familyDeps)) ||
      Object.values(tc).some(
        (v) =>
          Array.isArray(v) && v.every((x) => typeof x === "string") && ids.every((id) => (v as string[]).includes(id)),
      );
    if (ids.length > 1 && !routeExclusive && !declaredFamily) {
      findings.push({
        check: "duplicate-evidence-producer",
        path: `nodes.${ids[0]}.evidence`,
        message: `Evidence key "${key}" is produced by ${ids.length} nodes (${ids.join(", ")}) — concurrent producers race the single gate file for this key`,
        severity: "warn",
      });
    }
  }

  // 5b. criteria: ids must be declared keys, unique, and backed by registry files
  const seenCriteria = new Set<string>();
  for (const id of graph.evidence.criteria ?? []) {
    if (!produced.has(id) && !graph.evidence.required_keys.includes(id)) {
      findings.push({
        check: "criteria-keys",
        path: "evidence.criteria",
        message: `Criterion "${id}" is not a required key nor produced by any node`,
      });
    }
    if (seenCriteria.has(id)) {
      findings.push({
        check: "criteria-keys",
        path: "evidence.criteria",
        message: `Duplicate criterion id "${id}"`,
      });
    }
    seenCriteria.add(id);
    const file = join(projectRoot, "criteria", `${id}.md`);
    if (!existsSync(file)) {
      findings.push({
        check: "criteria-file",
        path: "evidence.criteria",
        message: `Criterion "${id}" has no registry file at criteria/${id}.md`,
      });
    } else {
      const head = readFileSync(file, "utf-8").match(/^---\n([\s\S]*?)\n---/);
      const fmId = head ? YAML.parse(head[1])?.id : undefined;
      if (fmId !== undefined && fmId !== id) {
        findings.push({
          check: "criteria-file",
          path: `criteria/${id}.md`,
          message: `Registry file frontmatter id "${fmId}" does not match filename "${id}"`,
        });
      }
    }
  }

  // 6. memory-augmented topology contract
  if (graph.topology === "memory-augmented") {
    const tc = graph.topology_config as Record<string, any>;
    const inner = tc?.inner;
    if (!inner || typeof inner !== "object" || !("template" in inner)) {
      findings.push({
        check: "memory-inner",
        path: "topology_config.inner",
        message: "memory-augmented requires topology_config.inner.template (a base topology)",
      });
    }
    const mem = tc?.memory as Record<string, any> | undefined;
    const curatorNode = mem?.curator_node ?? "curator";
    if (!graph.nodes[curatorNode]) {
      findings.push({
        check: "memory-curator-node",
        path: `nodes.${curatorNode}`,
        message: `memory-augmented memory.curator_node "${curatorNode}" is not defined in nodes`,
      });
    }
  }

  // 7. Node role contract. eval-gate and supervisor are semantic roles; any
  // other string is allowed (free-form) but surfaces an advisory warning so
  // typos like "supervsor" are visible.
  for (const [id, node] of Object.entries(graph.nodes)) {
    if (node.role === "eval-gate") {
      if (!node.eval) {
        findings.push({
          check: "eval-gate-config",
          path: `nodes.${id}.eval`,
          message: "eval-gate node requires an `eval` config block",
        });
      }
      if (!node.depend_on || node.depend_on.length === 0) {
        findings.push({
          check: "eval-gate-depend_on",
          path: `nodes.${id}.depend_on`,
          message: "eval-gate node must depend_on at least one producer node",
        });
      }
    }
    if (node.role && node.role !== "eval-gate" && node.role !== "supervisor") {
      findings.push({
        check: "unknown-role",
        path: `nodes.${id}.role`,
        message: `Unknown role "${node.role}" — advisory warning only; known roles: eval-gate, supervisor`,
        severity: "warn",
      });
    }
  }
  // 7b. Owned-scope overlap (HEURISTIC ADVISORY WARNING, not an error): two
  // nodes in the same topological wave declaring owns globs with a shared
  // literal ancestor may write the same files concurrently. We compare literal
  // directory prefixes (text before the first wildcard, cut to the last path
  // segment) — identical patterns or a root-scoped pattern count as overlap.
  // A wildcard can still escape these prefixes, so treat findings as review
  // prompts, not proof.
  const globsOverlap = (a: string, b: string): boolean => {
    if (a === b) return true;
    const anc = (glob: string): string => {
      const cut = glob.search(/[*?[{]/);
      const literal = cut === -1 ? glob : glob.slice(0, cut);
      return literal.slice(0, literal.lastIndexOf("/") + 1);
    };
    const [da, db] = [anc(a), anc(b)];
    if (da === "" || db === "") return true;
    const [short, long] = da.length <= db.length ? [da, db] : [db, da];
    return long.startsWith(short);
  };
  const { waves } = topoWaves(graph.nodes);
  const isGated = (id: string) =>
    graph.nodes[id]?.constraints.some((c) => c.no_write === true || c.no_exec === true) ?? false;
  for (const wave of waves) {
    const scoped = wave.filter((id) => (graph.nodes[id]?.owns.length ?? 0) > 0);
    for (let i = 0; i < scoped.length; i++) {
      for (let j = i + 1; j < scoped.length; j++) {
        const a = scoped[i];
        const b = scoped[j];
        if (isGated(a) || isGated(b)) continue;
        if (!graph.nodes[a].owns.some((ga) => graph.nodes[b].owns.some((gb) => globsOverlap(ga, gb)))) continue;
        findings.push({
          check: "owns-overlap",
          path: `nodes.${a}.owns`,
          message: `Nodes "${a}" and "${b}" in the same wave declare potentially overlapping owns globs (heuristic advisory) and neither has no_write/no_exec`,
          severity: "warn",
        });
      }
    }
  }

  // 7c. Constraint provenance (ADVISORY): a constraint may carry `source` to
  // mark who declared it — "human" (operator, agents must never modify it) or
  // "author" (default, graph author). Any other value is a typo surfacing as a
  // review prompt.
  for (const [id, node] of Object.entries(graph.nodes)) {
    for (const c of node.constraints) {
      if ("source" in c && c.source !== "human" && c.source !== "author") {
        findings.push({
          check: "constraint-source",
          path: `nodes.${id}.constraints`,
          message: `constraint source "${String(c.source)}" must be "human" or "author" ("human" constraints are agent-immutable)`,
          severity: "warn",
        });
      }
    }
  }

  // 7d. Constraint value shapes (ADVISORY): recognized keys carry recognized
  // value shapes — a wrong shape is a silent no-op at materialization time
  // (nodeTools ignores it), so surface it here. Unknown keys stay free-form
  // prose (constraints are open by design).
  for (const [id, node] of Object.entries(graph.nodes)) {
    for (const c of node.constraints) {
      for (const [k, v] of Object.entries(c)) {
        if ((k === "no_write" || k === "no_exec") && typeof v !== "boolean") {
          findings.push({
            check: "constraint-value",
            path: `nodes.${id}.constraints`,
            message: `constraint ${k} expects true or false, got ${JSON.stringify(v)} — non-boolean values are ignored`,
            severity: "warn",
          });
        } else if (k === "tools_allowlist" && typeof v !== "string" && !Array.isArray(v)) {
          findings.push({
            check: "constraint-value",
            path: `nodes.${id}.constraints`,
            message: `constraint tools_allowlist expects "Read, Grep" or a list of tool names, got ${JSON.stringify(v)} — other shapes are ignored`,
            severity: "warn",
          });
        }
      }
    }
  }

  // 8. Loop group rules
  if (graph.loops && graph.loops.length > 0) {
    const seenLoopNodes = new Set<string>();

    for (let i = 0; i < graph.loops.length; i++) {
      const loop = graph.loops[i];
      const loopNodeSet = new Set<string>();

      // Rule 1: loop_node_exists
      let allNodesExist = true;
      for (const nodeName of loop.nodes) {
        if (!graph.nodes[nodeName]) {
          allNodesExist = false;
          findings.push({
            check: "loop_node_exists",
            path: `loops[${i}].nodes`,
            message: `Loop node "${nodeName}" does not exist in graph.nodes`,
          });
        } else {
          loopNodeSet.add(nodeName);
        }
      }

      // Rule 2: loop_no_overlap
      for (const nodeName of loop.nodes) {
        if (seenLoopNodes.has(nodeName)) {
          findings.push({
            check: "loop_no_overlap",
            path: `loops[${i}].nodes`,
            message: `Node "${nodeName}" appears in more than one loop group`,
          });
        }
        seenLoopNodes.add(nodeName);
      }

      // Rule 3: loop_gate_evidence_declared
      if (loop.gate_evidence) {
        const loopProducedEvidence = new Set<string>();
        for (const nodeName of loop.nodes) {
          const node = graph.nodes[nodeName];
          if (node?.evidence) {
            for (const key of node.evidence) {
              loopProducedEvidence.add(key);
            }
          }
        }
        for (const key of loop.gate_evidence) {
          if (!loopProducedEvidence.has(key)) {
            findings.push({
              check: "loop_gate_evidence_declared",
              path: `loops[${i}].gate_evidence`,
              message: `gate_evidence key "${key}" is not declared by any node in the loop group`,
            });
          }
        }
      }

      // Rule 4: loop_contiguous (topological wave span closure)
      // Every loop-node dependency must either be within the loop group or strictly upstream of its minimum wave.
      if (allNodesExist && loop.nodes.length > 0) {
        const memoWaves = new Map<string, number>();
        const visiting = new Set<string>();
        const computeWave = (nodeId: string): number => {
          if (memoWaves.has(nodeId)) return memoWaves.get(nodeId)!;
          if (visiting.has(nodeId)) return 0;
          visiting.add(nodeId);
          const deps = graph.nodes[nodeId]?.depend_on ?? [];
          let maxDepWave = -1;
          for (const dep of deps) {
            if (graph.nodes[dep]) {
              maxDepWave = Math.max(maxDepWave, computeWave(dep));
            }
          }
          visiting.delete(nodeId);
          const wave = maxDepWave + 1;
          memoWaves.set(nodeId, wave);
          return wave;
        };

        for (const id of Object.keys(graph.nodes)) {
          computeWave(id);
        }

        let loopMinWave = Number.POSITIVE_INFINITY;
        for (const nodeName of loop.nodes) {
          const w = memoWaves.get(nodeName) ?? 0;
          if (w < loopMinWave) loopMinWave = w;
        }

        for (const loopNode of loop.nodes) {
          const directDeps = graph.nodes[loopNode]?.depend_on ?? [];
          for (const dep of directDeps) {
            if (!loopNodeSet.has(dep) && graph.nodes[dep]) {
              const depWave = memoWaves.get(dep) ?? 0;
              if (depWave >= loopMinWave) {
                findings.push({
                  check: "loop_contiguous",
                  path: `loops[${i}].nodes`,
                  message: `Loop group is non-contiguous: dependency "${dep}" of loop node "${loopNode}" has wave ${depWave}, which is inside or past loop min wave ${loopMinWave}`,
                });
              }
            }
          }
        }
      }
    }
  }

  return findings;
}
