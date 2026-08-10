export const TOPOLOGY_NAMES = [
  "diamond",
  "classify-and-act",
  "adversarial-verification",
  "loop-until-done",
  "generate-and-filter",
  "tournament",
  "memory-augmented",
  "custom",
  "sdd",
  "superpowers",
  "research-and-build",
] as const;

export type TopologyName = (typeof TOPOLOGY_NAMES)[number];

const TOPOLOGY_CONFIG_KEYS: Record<TopologyName, string[]> = {
  diamond: ["fanout.strategy", "fanout.isolation", "reduce", "verify", "synthesizer"],
  "classify-and-act": ["classifier", "routes[].handler", "routes[].condition", "fallback"],
  "adversarial-verification": ["producer", "refuters[]", "survive_threshold", "adjudicator"],
  "loop-until-done": ["scouter", "worker_batch", "stop_rule", "dedup", "dry_threshold"],
  "generate-and-filter": ["generators[]", "rubric", "keep_top", "dedup_keys", "scorer"],
  tournament: ["candidates[]", "judge", "rounds"],
  "memory-augmented": [
    "inner.template",
    "memory.project",
    "memory.cadence",
    "memory.curator_node",
    "memory.recall_topk",
    "memory.expire_policy",
  ],
  custom: [],
  sdd: [],
  superpowers: [],
  "research-and-build": [],
};

export function getTopologyConfigKeys(topology: TopologyName): string[] {
  return TOPOLOGY_CONFIG_KEYS[topology];
}
