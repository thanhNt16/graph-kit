---
name: factory-heresy-lint
description: Flag diff claims that contradict the card's stated intent — the cheapest review pass that catches solution-drift. Used by the review lane agent.
disable-model-invocation: true
---

# factory heresy lint

Solution-drift: the build "succeeded" at a different task than the card asked.

## Process

1. Read the card title/body and each acceptance criterion.
2. For each criterion, answer: does the diff implement *this* or something adjacent?
3. Common heresies:
   - Implemented the mechanism, skipped the outcome ("added flag" ≠ "bug fixed").
   - Solved a broader/narrower problem than asked.
   - Docs claim a behavior the code doesn't have.

## Output

Include in `gk-review` issues with `severity: blocker` and `what` starting `heresy:` — e.g. `heresy: card asks for pagination, diff adds a "load more" button`.
