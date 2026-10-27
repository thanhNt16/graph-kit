---
name: factory-proof
description: Demand evidence over assertion — every claim must cite a command, file:hunk, or observable state. Shared by QA and review lane agents.
disable-model-invocation: true
---

# factory proof

The factory's contract is evidence-in-ledger. When verifying:

- A criterion is **met** only with a citation: `path:line`, a passing command, or a recorded observation.
- "Looks right" is not proof. "Tests pass" without the command output is not proof.
- Unknown ≠ pass. If you cannot verify a criterion within your tools, mark it `unverified` — the dispatcher decides, not you.

## Proof grades

| Grade | Meaning |
|---|---|
| command | a runnable check exits 0 |
| citation | code location demonstrating the claim |
| observation | runtime/UI state you saw |
| none | assertion without support → fails |

Include the grade per criterion in your output block.
