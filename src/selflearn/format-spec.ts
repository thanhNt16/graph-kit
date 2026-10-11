// Authoring + format spec — the single source the reflector writes to and
// the promote lint enforces. Port of autoharness lib/format_spec.md (MIT),
// adapted to the kit intent shape (kind/target/reason/evidence/body).

export const SKILL_FORMAT_SPEC = `# SKILL.md format spec (gk selflearn)

Every learned skill is one SKILL.md inside the host's skill dir and must satisfy the checks below.
The gk-reflector authors against this spec; the promote lint enforces it — keep them aligned.

## Required frontmatter

- \`name\` — short identifier for the skill.
- \`description\` — the trigger; see below. A cue-less label never fires and is rejected.
- \`category\` — one lowercase word or hyphenated phrase naming the class of work. Reuse one
  already visible in the index; mint a new one only when nothing existing fits. Missing category
  lands under \`general\` (noted, not rejected); an illegal value (not a single safe segment of
  letters/digits/._-) IS rejected.

## Description is the trigger — one sentence, inside the index budget

The description is the routing signal and the session-start index line. Budget: 60 chars —
over budget the index truncates mid-clause and the routing signal dies, so create/update over it
is REJECTED. Write one sentence, trigger first, ending in a period; name the concrete objects
and the words a user would actually type. The promoter rejects a create/update whose description
exceeds 60 chars or carries no trigger cue (a 'when' clause or a quoted literal phrase).

Good: \`Use when a fetch fails: 403/429, paywall, WAF, bot wall.\`
Bad:  \`Manages project operations\` — a topic label with no trigger at all.

## Altitude — the body is a rule, not a transcript

- Open with the rule itself: the reusable directive in one or two lines.
- A full explainer is a smell — keep the rule in SKILL.md, hoist detail into references/.
- Hard cap (enforced): the body (frontmatter excluded) must be at most 25 non-blank lines for
  create/update. patch is exempt so an over-long skill stays fixable.

## Content completeness

- No TODO / FIXME / XXX / placeholder tokens, no empty sections.

## Intents (the only emit path: \`gk selflearn stage --intent <json>\`)

- \`kind\`: \`create\` | \`update\` | \`patch\` | \`delete\`.
- \`target\`: the skill name (a single safe segment).
- create/update carry the FULL SKILL.md \`body\` satisfying this spec; \`target\` must not already
  exist for create and MUST exist for update/patch/delete.
- patch carries \`old\` → \`new\` (the old text must match the live body uniquely).
- delete carries no body; set \`absorbed_into\` when the skill's content was folded into another
  (the umbrella must be a live self-learned skill or the intent rejects).
- \`reason\` and \`evidence\` are REQUIRED on every intent; evidence must be a verbatim slice
  (>= 1 line) from the episode window — the promoter materializes it as permanent provenance.
- update/patch/delete only ever touch self-learned skills (the .selflearn marker); intents
  targeting kit-native or user skills are rejected.
`;
