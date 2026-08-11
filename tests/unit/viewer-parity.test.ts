import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const claudeViewer = join(root, "claude", "viewer");
const cursorViewer = join(root, "cursor", "viewer");

describe("viewer kit parity", () => {
  test("claude and cursor viewer assets are byte-equivalent", () => {
    const files = ["index.html", "app.js", "styles.css", "dagre.js"];
    for (const f of files) {
      const c = join(claudeViewer, f);
      const cu = join(cursorViewer, f);
      expect(existsSync(c), `missing ${c}`).toBe(true);
      expect(existsSync(cu), `missing ${cu}`).toBe(true);
      expect(readFileSync(c, "utf-8"), `${f} differs`).toBe(readFileSync(cu, "utf-8"));
    }
  });
});

describe("browser asset contracts", () => {
  test("index.html loads only self-hosted assets (CSP compatible)", () => {
    const html = readFileSync(join(claudeViewer, "index.html"), "utf-8");
    expect(html).toContain('src="./dagre.js"');
    expect(html).toContain('src="./app.js"');
    expect(html).toContain('rel="stylesheet" href="./styles.css"');
    // no inline scripts, no external URLs
    expect(html).not.toMatch(/<script>(?!.*src=)/);
    expect(html).not.toMatch(/https?:\/\//);
  });

  test("dagre.js exposes a dagre global (IIFE bundle)", () => {
    const dagre = readFileSync(join(claudeViewer, "dagre.js"), "utf-8");
    expect(dagre).toContain("globalThis.dagre");
    expect(dagre).not.toMatch(/\bimport\s/);
    expect(dagre).not.toMatch(/https?:\/\//);
  });

  test("app.js inserts all graph strings as text — innerHTML only used to clear a container", () => {
    const app = readFileSync(join(claudeViewer, "app.js"), "utf-8");
    // innerHTML appears only in the reset; never with graph data interpolated
    const innerHtmlUses = app.match(/innerHTML\s*=\s*[^;]*;/g) || [];
    for (const use of innerHtmlUses) {
      expect(use.match(/["']([^"']*)\s*\+/) === null, `interpolation into innerHTML: ${use}`).toBe(true);
    }
    expect(app).toContain("document.createTextNode");
    expect(app).toContain("EventSource");
    expect(app).toContain("encodeURIComponent(KEY)");
  });

  test("app.js implements pan/zoom/fit/search/filter/keyboard contracts", () => {
    const app = readFileSync(join(claudeViewer, "app.js"), "utf-8");
    expect(app).toContain("fitView");
    expect(app).toContain("zoomBy");
    expect(app).toContain("mouseAnchor");
    expect(app).toContain("matchesSearch");
    expect(app).toContain("filterModel");
    expect(app).toContain('key === "Escape"');
    expect(app).toContain('key === "Enter"');
  });

  test("app.js sets focus emphasis on focusin/focusout like hover (keyboard accessibility)", () => {
    const app = readFileSync(join(claudeViewer, "app.js"), "utf-8");
    expect(app).toContain('addEventListener("focusin"');
    expect(app).toContain('addEventListener("focusout"');
    expect(app).toContain("state.focus");
    expect(app).toContain("updateViewState");
  });

  test("app.js dims (not hides) nodes that miss search/filters via the filtered class", () => {
    const app = readFileSync(join(claudeViewer, "app.js"), "utf-8");
    expect(app).toContain('classList.add("filtered")');
    expect(app).toContain("dataset.visible");
  });

  test("app.js preserves viewport + selection across valid updates; fits only initial load", () => {
    const app = readFileSync(join(claudeViewer, "app.js"), "utf-8");
    expect(app).toContain("retainedSelection");
    expect(app).toContain("shouldFit");
    expect(app).toContain("fitView");
    // selection is retained (not unconditionally cleared) on a valid update
    expect(app).toContain("retainedSelection(state.selected,");
  });

  test("bundled viewer launcher (server.mjs) exists and starts the read-only server", () => {
    const server = readFileSync(join(claudeViewer, "server.mjs"), "utf-8");
    expect(server).toContain("startViewerServer");
    expect(server).toContain("GraphKit viewer:");
    expect(server).toContain("127.0.0.1");
    // cursor parity for the launcher too
    const cursorServer = readFileSync(join(cursorViewer, "server.mjs"), "utf-8");
    expect(cursorServer).toBe(server);
  });

  test("styles.css defines reduced-motion and focus styles; index.html references dagre", () => {
    const css = readFileSync(join(claudeViewer, "styles.css"), "utf-8");
    const html = readFileSync(join(claudeViewer, "index.html"), "utf-8");
    expect(css).toContain("prefers-reduced-motion");
    expect(css).toContain(":focus-visible");
    // reduced-motion parity: every motion source is disabled inside the block
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*animation:\s*none/);
    expect(html).toContain("dagre.js");
  });

  test("viewer is dark-first with complete explicit light and dark palettes", () => {
    const css = readFileSync(join(claudeViewer, "styles.css"), "utf-8");
    for (const token of ["--bg", "--surface", "--ink", "--muted", "--hairline", "--accent", "--tier-opus"]) {
      expect(css, `${token} default`).toMatch(new RegExp(`:root\\s*\\{[^}]*${token}:`, "s"));
      expect(css, `${token} light`).toMatch(new RegExp(`data-theme="light"\\]\\s*\\{[^}]*${token}:`, "s"));
      expect(css, `${token} dark`).toMatch(new RegExp(`data-theme="dark"\\]\\s*\\{[^}]*${token}:`, "s"));
    }
    expect(css).toContain("prefers-reduced-motion: reduce");
  });

  test("editorial shell exposes phase-lane and card styling hooks", () => {
    const html = readFileSync(join(claudeViewer, "index.html"), "utf-8");
    const css = readFileSync(join(claudeViewer, "styles.css"), "utf-8");
    expect(html).toContain('id="toggle-lanes"');
    expect(html).toContain('aria-label="Show phase lanes"');
    for (const hook of [".lane", ".lane-label", ".node-tier-rail", ".node-badge", ".node-group.selected"]) {
      expect(css).toContain(hook);
    }
  });
});
