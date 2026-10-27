---
name: factory-ui-journey
description: Verify UI-affecting cards by walking the declared user journeys — dev server, routes, observable behavior. Used by the QA lane agent when qa.ui.journeys is configured.
disable-model-invocation: true
---

# factory ui journey

For cards that touch UI: green unit tests don't prove the journey works.

## Process

1. If `qa.ui.dev_server` is configured, start it (or use the running one the prompt names) and wait for the ready signal.
2. Walk each journey in `qa.ui.journeys`: route → expected observable state. Record what you actually saw.
3. A journey fails on: 404/500, missing element named in the journey, console error mentioning the changed surface.
4. Emit per-journey results inside the `gk-qa` block:

```
"journeys": [{"name": "login", "ok": true, "observed": "dashboard renders"}]
```

## Rules

- Observe, don't fix. A broken journey is evidence for a fail verdict.
- If no dev server is available and the card touches UI, say `untested` for that journey — never claim it passed.
