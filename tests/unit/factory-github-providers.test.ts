/** GitHub adapters against a recorded `gh` fixture — no network. The fake
 *  exec routes argv → canned JSON and records mutations for assertions. */
import { describe, expect, test } from "bun:test";
import type { LaneKey } from "../../src/factory/config";
import { type GhExec, GitHubBoardProvider, GitHubVCSProvider } from "../../src/factory/providers/github";

const LANES: Record<LaneKey, string> = {
  ready: "Ready",
  building: "Building",
  qa: "In QA",
  review: "Under Review",
  blocked: "Blocked",
  done: "Done",
};

interface GhState {
  items: Array<{
    id: string;
    title: string;
    status?: string;
    content?: { number?: number; title?: string };
  }>;
  issues: Record<
    number,
    {
      number: number;
      title: string;
      body: string;
      labels: Array<{ name: string }>;
      html_url: string;
      updated_at: string;
    }
  >;
  comments: Record<number, Array<{ id: number; body: string; user: { login: string }; created_at: string }>>;
  prs: Record<string, { number: number; url: string; state: string; mergeCommit?: { oid: string } }>;
  checks: Record<number, Array<{ name: string; state: string; link?: string }>>;
  calls: string[][];
  commentSeq: number;
}

function fakeGh(state: GhState): GhExec {
  return (argv) => {
    state.calls.push(argv);
    const args = argv[0] === "gh" || argv[0] === "git" ? argv.slice(1) : argv;
    if (args[0] === "-C") return ""; // git -C <wt> push
    const joined = args.join(" ");
    if (joined.startsWith("project item-list")) {
      return JSON.stringify({ items: state.items });
    }
    if (joined.startsWith("project field-list")) {
      return JSON.stringify({
        fields: [
          {
            id: "FIELD_STATUS",
            name: "Status",
            type: "single_select",
            options: Object.entries(LANES).map(([lane, name]) => ({ id: `OPT_${lane}`, name })),
          },
        ],
      });
    }
    if (joined.startsWith("project list")) {
      return JSON.stringify({ projects: [{ id: "PROJ_1", number: 7 }] });
    }
    if (joined.startsWith("project item-edit")) {
      const itemId = args[args.indexOf("--id") + 1];
      const optId = args[args.indexOf("--single-select-option-id") + 1];
      const lane = optId.replace("OPT_", "");
      const item = state.items.find((i) => i.id === itemId);
      if (item) item.status = LANES[lane as LaneKey];
      return "";
    }
    if (joined.includes("/issues/") && joined.includes("/comments")) {
      if (joined.includes("-X PATCH")) {
        const cid = Number(joined.match(/comments\/(\d+)/)![1]);
        const body = args[args.indexOf("-f") + 1].replace(/^body=/, "");
        for (const list of Object.values(state.comments)) {
          const c = list.find((c) => c.id === cid);
          if (c) c.body = body;
        }
        return "{}";
      }
      const n = Number(joined.match(/issues\/(\d+)/)![1]);
      if (args.includes("-f")) {
        const body = args[args.indexOf("-f") + 1].replace(/^body=/, "");
        const id = state.commentSeq + 1;
        state.commentSeq = id;
        const list = state.comments[n] ?? [];
        state.comments[n] = list;
        list.push({ id, body, user: { login: "gk-factory" }, created_at: "2026-10-26T00:00:00Z" });
        return JSON.stringify({ id });
      }
      return JSON.stringify(state.comments[n] ?? []);
    }
    if (joined.includes("/labels")) {
      const n = Number(joined.match(/issues\/(\d+)/)![1]);
      if (joined.includes("-X POST")) {
        const label = args[args.indexOf("-f") + 1].replace(/^labels\[\]=/, "");
        state.issues[n].labels.push({ name: label });
        return "{}";
      }
      if (joined.includes("-X DELETE")) {
        const label = decodeURIComponent(joined.split("/labels/")[1]);
        state.issues[n].labels = state.issues[n].labels.filter((l) => l.name !== label);
        return "{}";
      }
    }
    if (joined.startsWith("api repos/") && joined.includes("/issues/")) {
      const n = Number(joined.match(/issues\/(\d+)/)![1]);
      const i = state.issues[n];
      return JSON.stringify({
        number: i.number,
        title: i.title,
        body: i.body,
        labels: i.labels,
        url: i.html_url,
        updated_at: i.updated_at,
      });
    }
    if (joined.startsWith("pr view")) {
      const ref = args[2];
      const pr = state.prs[ref] ?? Object.values(state.prs).find((p) => String(p.number) === ref);
      if (!pr) throw new Error("not found");
      return JSON.stringify({ number: pr.number, url: pr.url, mergeCommit: pr.mergeCommit });
    }
    if (joined.startsWith("pr create")) {
      const head = args[args.indexOf("--head") + 1];
      const num = Object.keys(state.prs).length + 1;
      state.prs[head] = { number: num, url: `https://github.com/o/r/pull/${num}`, state: "open" };
      return `https://github.com/o/r/pull/${num}`;
    }
    if (joined.startsWith("pr checks")) {
      const num = Number(args[2]);
      return JSON.stringify(state.checks[num] ?? []);
    }
    if (joined.startsWith("pr merge")) {
      const num = Number(args[2]);
      const pr = Object.values(state.prs).find((p) => p.number === num);
      if (pr) {
        pr.state = "merged";
        pr.mergeCommit = { oid: "abc123" };
      }
      return "";
    }
    if (joined.startsWith("pr edit")) return "{}";
    throw new Error(`unhandled gh args: ${joined}`);
  };
}

function seeded(): GhState {
  return {
    items: [
      { id: "PVTI_1", title: "card one", status: "Ready", content: { number: 412, title: "card one" } },
      { id: "PVTI_2", title: "card two", status: "Building", content: { number: 413, title: "card two" } },
    ],
    issues: {
      412: {
        number: 412,
        title: "card one",
        body: "do x",
        labels: [{ name: "factory" }],
        html_url: "https://github.com/o/r/issues/412",
        updated_at: "2026-10-26T00:00:00Z",
      },
      413: {
        number: 413,
        title: "card two",
        body: "do y",
        labels: [],
        html_url: "https://github.com/o/r/issues/413",
        updated_at: "2026-10-26T00:01:00Z",
      },
    },
    comments: {},
    prs: {},
    checks: {},
    calls: [],
    commentSeq: 0,
  };
}

const CFG = {
  owner: "o",
  repo: "r",
  project_number: 7,
  status_field: "Status",
  lanes: LANES,
  halt_label: "factory:halt",
};

describe("GitHubBoardProvider", () => {
  test("lanes map to status options; getCardsInLane filters + sorts", async () => {
    const s = seeded();
    const board = new GitHubBoardProvider(CFG, fakeGh(s));
    const ready = await board.getCardsInLane("ready");
    expect(ready.map((c) => c.key)).toEqual(["#412"]);
    expect(ready[0].lane).toBe("ready");
    expect(ready[0].labels).toEqual(["factory"]);
  });

  test("moveCardLane edits the single-select option", async () => {
    const s = seeded();
    const board = new GitHubBoardProvider(CFG, fakeGh(s));
    await board.moveCardLane("PVTI_1", "building");
    expect(s.items.find((i) => i.id === "PVTI_1")?.status).toBe("Building");
    const edit = s.calls.find((c) => c.join(" ").includes("item-edit"))!;
    expect(edit).toContain("OPT_building");
  });

  test("upsertComment is marker-idempotent", async () => {
    const s = seeded();
    const board = new GitHubBoardProvider(CFG, fakeGh(s));
    const a = await board.upsertComment("PVTI_1", "<!-- gk-factory card=PVTI_1 -->", "first");
    const b = await board.upsertComment("PVTI_1", "<!-- gk-factory card=PVTI_1 -->", "second");
    expect(a.commentId).toBe(b.commentId);
    const comments = await board.listComments("PVTI_1");
    expect(comments.length).toBe(1);
    expect(comments[0].body).toContain("second");
  });

  test("isTaskHalted on label or lane drift", async () => {
    const s = seeded();
    const board = new GitHubBoardProvider(CFG, fakeGh(s));
    expect(await board.isTaskHalted("PVTI_1", "ready")).toBe(false);
    await board.addLabel("PVTI_1", "factory:halt");
    expect(await board.isTaskHalted("PVTI_1", "ready")).toBe(true);
    await board.removeLabel("PVTI_1", "factory:halt");
    expect(await board.isTaskHalted("PVTI_1", "ready")).toBe(false);
    expect(await board.isTaskHalted("PVTI_1", "done")).toBe(true); // lane drift
    expect(await board.isTaskHalted("PVTI_missing", "ready")).toBe(true);
  });
});

describe("GitHubVCSProvider", () => {
  test("openPullRequest idempotent on branch; checks map states; merge reports sha", async () => {
    const s = seeded();
    const gh = fakeGh(s);
    const vcs = new GitHubVCSProvider({ owner: "o", name: "r" }, gh);
    const a = await vcs.openPullRequest({
      sourceBranch: "factory/c1",
      targetBranch: "main",
      title: "t",
      body: "b",
      draft: true,
    });
    const b = await vcs.openPullRequest({ sourceBranch: "factory/c1", targetBranch: "main", title: "t", body: "b" });
    expect(a.number).toBe(b.number);
    expect(s.calls.filter((c) => c.join(" ").includes("pr create")).length).toBe(1);

    s.checks[a.number] = [{ name: "test", state: "PENDING" }];
    expect((await vcs.getChecks(a.number)).state).toBe("pending");
    s.checks[a.number] = [{ name: "test", state: "FAILURE", link: "u" }];
    const fail = await vcs.getChecks(a.number);
    expect(fail.state).toBe("failure");
    expect(fail.failing[0].name).toBe("test");
    s.checks[a.number] = [{ name: "test", state: "SUCCESS" }];
    expect((await vcs.getChecks(a.number)).state).toBe("success");
    expect((await vcs.getChecks(999)).state).toBe("none");

    const { sha } = await vcs.mergePR(a.number, "squash");
    expect(sha).toBe("abc123");
    expect(s.calls.some((c) => c.join(" ").includes("--squash"))).toBe(true);
  });
});
