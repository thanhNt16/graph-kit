import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { buildViews, renderHtml, renderMarkdown } from "../../src/evidence/report.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

let cwd: string;
const graphYaml = `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: t
topology: diamond
nodes:
  probe:
    agent: a
    objective: o
    depend_on: []
    evidence: [api-response]
evidence:
  required_keys: [api-response]
  criteria: [api-response]
`;

beforeEach(() => {
  cwd = join(tmpdir(), `gk-rep-${process.pid}-${Date.now()}`);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(cwd, ".graphkit", "evidence"), { recursive: true });
  mkdirSync(join(cwd, "criteria"), { recursive: true });
  writeFileSync(join(cwd, "graph.yaml"), graphYaml);
  writeFileSync(join(cwd, "criteria", "api-response.md"), "---\nkind: json\n---\nGET /users 200\n");
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function graph() {
  return GraphSchema.parse(YAML.parse(readFileSync(join(cwd, "graph.yaml"), "utf-8")));
}

describe("evidence report", () => {
  test("views carry criteria metadata + marker provenance", () => {
    const ev = join(cwd, ".graphkit", "evidence");
    writeFileSync(join(ev, "resp.json"), '{"ok":true}');
    writeFileSync(
      join(ev, "api-response.md"),
      `---\nkey: api-response\nrun_id: r1\nnode: probe\nfingerprint_head: ${"a".repeat(40)}\nfingerprint_tree: ${"b".repeat(64)}\nartifact: api-response/abc.json\nts: 2026-09-05T09:00:00.000Z\n---\n\nbody\n`,
    );
    const views = buildViews(cwd, graph());
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      id: "api-response",
      description: "GET /users 200",
      kind: "json",
      status: "present",
      artifact: "api-response/abc.json",
    });
    expect(views[0].provenance).toContain("r1");
    expect(views[0].provenance).toContain("probe");
  });

  test("missing key → missing view", () => {
    const views = buildViews(cwd, graph());
    expect(views[0].status).toBe("missing");
    expect(views[0].freshness).toBe("unknown");
  });

  test("markdown: badges + provenance lines", () => {
    writeFileSync(
      join(cwd, ".graphkit", "evidence", "api-response.md"),
      `---\nkey: api-response\nrun_id: r1\nnode: probe\n---\n\nbody\n`,
    );
    const md = renderMarkdown("t", buildViews(cwd, graph()));
    expect(md).toContain("● present");
    expect(md).toContain("? unknown");
    expect(md).toContain("run r1 · node probe");
  });

  test("html: json artifact escaped, no script execution path", () => {
    const ev = join(cwd, ".graphkit", "evidence");
    const evil = '{"payload":"<script>alert(1)</script>"}';
    writeFileSync(join(ev, "payload.json"), evil);
    const sha = "d".repeat(64);
    writeFileSync(join(ev, `payload-${sha}.json`), evil); // not referenced; only marker artifact path is read
    writeFileSync(
      join(ev, "api-response.md"),
      `---\nkey: api-response\nnode: probe\nartifact: api-response/${sha}.json\n---\n\nbody\n`,
    );
    mkdirSync(join(ev, "api-response"), { recursive: true });
    writeFileSync(join(ev, "api-response", `${sha}.json`), evil);
    const html = renderHtml("t", buildViews(cwd, graph()), ev);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toMatch(/<script/);
  });

  test("html: svg screenshot refused inline (link only)", () => {
    const ev = join(cwd, ".graphkit", "evidence");
    mkdirSync(join(ev, "shot"), { recursive: true });
    writeFileSync(join(ev, "shot", "abc.svg"), '<svg onload="alert(1)"></svg>');
    // this case exercises the screenshot branch: switch the registry kind
    writeFileSync(join(cwd, "criteria", "api-response.md"), "---\nkind: screenshot\n---\nshot of the thing\n");
    writeFileSync(join(ev, "api-response.md"), `---\nkey: api-response\nartifact: shot/abc.svg\n---\n\nbody\n`);
    const html = renderHtml("t", buildViews(cwd, graph()), ev);
    expect(html).not.toContain("data:image/svg");
    expect(html).toContain("shot/abc.svg");
  });
});
