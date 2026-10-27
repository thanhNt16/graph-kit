/** `gk factory serve` — local read-only-ish dashboard over the factory's
 *  state files: Kanban board (lane columns), per-card journal + comments,
 *  lane run records. Auto-refresh polling; POST /api/tick runs one planner
 *  tick so the board moves while you watch. node:http, no deps. */
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import YAML from "yaml";
import type { FactoryConfig } from "./config.js";
import { factoryDir, type Providers, type TickDeps, tick } from "./dispatcher.js";
import { listJournals, loadJournal } from "./journal.js";
import { runsDir } from "./lane-runner.js";

const LANES = ["ready", "building", "qa", "review", "blocked", "done"] as const;

interface BoardCardYaml {
  id: string;
  key: string;
  title: string;
  description?: string;
  labels?: string[];
  lane: string;
  comments?: Array<{ id: string; body: string; author?: string; createdAt?: string; marker?: string }>;
  updatedAt?: string;
}

function readBoard(cwd: string): BoardCardYaml[] {
  const dir = join(factoryDir(cwd), "board");
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".yaml"))
      .map((f) => YAML.parse(readFileSync(join(dir, f), "utf8")) as BoardCardYaml)
      .filter((c) => c?.id);
  } catch {
    return [];
  }
}

function readRuns(cwd: string) {
  try {
    return readdirSync(runsDir(cwd))
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ id: f.replace(/\.json$/, ""), record: JSON.parse(readFileSync(join(runsDir(cwd), f), "utf8")) }))
      .sort((a, b) => String(b.record.at ?? "").localeCompare(String(a.record.at ?? "")));
  } catch {
    return [];
  }
}

function state(cwd: string) {
  const cards = readBoard(cwd);
  const journals = listJournals(cwd);
  const runs = readRuns(cwd);
  const byLane: Record<string, BoardCardYaml[]> = {};
  for (const l of LANES) byLane[l] = [];
  for (const c of cards) {
    const bucket = byLane[c.lane] ?? [];
    byLane[c.lane] = bucket;
    bucket.push(c);
  }
  return { lanes: LANES, cards: byLane, journals, runs };
}

const CSS = `
:root{color-scheme:dark;--bg:#0d1117;--panel:#161b22;--border:#30363d;--fg:#e6edf3;--dim:#8b949e;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--accent:#58a6ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 ui-monospace,Menlo,monospace}
header{display:flex;align-items:center;gap:14px;padding:12px 20px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--bg)}
header h1{font-size:15px;margin:0;font-weight:600}
header .meta{color:var(--dim);font-size:12px}
button{background:#21262d;color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:5px 12px;cursor:pointer;font:inherit}
button:hover{border-color:var(--accent)}
button.busy{opacity:.5}
.board{display:grid;grid-template-columns:repeat(6,minmax(170px,1fr));gap:10px;padding:14px 20px;overflow-x:auto}
.lane{background:var(--panel);border:1px solid var(--border);border-radius:8px;min-height:300px}
.lane h2{margin:0;padding:10px 12px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);border-bottom:1px solid var(--border)}
.lane .count{float:right;color:var(--fg)}
.card{margin:8px;padding:9px 10px;border:1px solid var(--border);border-radius:6px;background:#0d1117;cursor:pointer}
.card:hover{border-color:var(--accent)}
.card .key{color:var(--dim);font-size:11px}
.card .title{font-size:13px;margin:2px 0 4px}
.card .phase{font-size:11px}
.phase.running,.phase.claimed{color:var(--accent)}.phase.done{color:var(--ok)}.phase.blocked,.phase.parked{color:var(--bad)}.phase.awaiting_advance{color:var(--warn)}
.labels span{border:1px solid var(--border);border-radius:10px;padding:0 7px;font-size:10px;color:var(--dim)}
.labels .halt{border-color:var(--bad);color:var(--bad)}
.drawer{position:fixed;top:0;right:0;bottom:0;width:min(560px,92vw);background:var(--panel);border-left:1px solid var(--border);overflow-y:auto;padding:18px 20px;display:none;z-index:10}
.drawer.open{display:block}
.drawer h2{font-size:15px;margin:0 0 4px}
.drawer .sub{color:var(--dim);font-size:12px;margin-bottom:12px}
.drawer h3{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin:18px 0 8px}
.hist{font-size:12px}.hist div{padding:3px 0;border-bottom:1px dashed #21262d}
.v-MERGE{color:var(--ok)}.v-BLOCK{color:var(--bad)}
pre{background:#0d1117;border:1px solid var(--border);border-radius:6px;padding:10px;font-size:11px;overflow-x:auto;white-space:pre-wrap;word-break:break-word}
.comment{border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin:6px 0;font-size:12px}
.comment .who{color:var(--dim);font-size:11px;margin-bottom:3px}
.runs table{width:100%;border-collapse:collapse;font-size:12px}
.runs td,.runs th{border-bottom:1px solid #21262d;padding:4px 6px;text-align:left}
#toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:var(--panel);border:1px solid var(--accent);border-radius:6px;padding:8px 14px;font-size:12px;display:none}
`;

const JS = `
async function api(p, m){ const r = await fetch(p, m ? {method:m} : {}); return r.json(); }
async function refresh(){
  const s = await api('/api/state');
  const b = document.getElementById('board'); b.innerHTML='';
  const jmap = Object.fromEntries((s.journals||[]).map(j=>[j.card,j]));
  for(const lane of s.lanes){
    const col=document.createElement('div');col.className='lane';
    const cards=s.cards[lane]||[];
    col.innerHTML='<h2>'+lane+'<span class="count">'+cards.length+'</span></h2>';
    for(const c of cards){
      const j=jmap[c.id]||{};
      const d=document.createElement('div');d.className='card';
      d.innerHTML='<div class="key">'+c.key+'</div><div class="title"></div>'+
        '<div class="phase '+(j.phase||'')+'">'+(j.phase||'untracked')+(j.round?' · r'+j.round:'')+'</div>'+
        '<div class="labels">'+((c.labels||[]).map(l=>'<span class="'+(l.includes('halt')?'halt':'')+'">'+l+'</span>').join(''))+'</div>';
      d.querySelector('.title').textContent=c.title;
      d.onclick=()=>openCard(c.id);col.appendChild(d);
    }
    b.appendChild(col);
  }
  const runs=(s.runs||[]).map(r=>'<tr><td>'+r.record.lane+'</td><td class="v-'+r.record.verdict+'">'+r.record.verdict+'</td><td>'+(r.record.note||'')+'</td><td>'+(r.record.at||'').slice(11,19)+'</td></tr>').join('');
  document.getElementById('runs').innerHTML='<table><tr><th>lane</th><th>verdict</th><th>note</th><th>at</th></tr>'+runs+'</table>';
  document.getElementById('ts').textContent='updated '+new Date().toLocaleTimeString();
}
async function openCard(id){
  const d=await api('/api/card/'+id);
  const el=document.getElementById('drawer');
  const j=d.journal||{};const c=d.card||{};
  el.innerHTML='<button onclick="closeCard()" style="float:right">close</button>'+
    '<h2></h2><div class="sub">'+id+' · lane <b>'+c.lane+'</b> · phase <b>'+(j.phase||'-')+'</b> · round '+(j.round??0)+(j.pr?' · PR #'+j.pr.number:'')+'</div>'+
    '<h3>history</h3><div class="hist">'+((j.history||[]).map(h=>'<div>'+(h.at||'').slice(11,19)+' · '+(h.from||'∅')+' → '+h.to+' · <span class="v-'+(h.verdict||'')+'">'+(h.verdict||'')+'</span> '+(h.note||'')+'</div>').join(''))+'</div>'+
    '<h3>comments</h3>'+((c.comments||[]).map(m=>'<div class="comment"><div class="who">'+(m.author||'')+' · '+(m.createdAt||'')+'</div><div>'+(m.body||'').replace(/</g,'&lt;')+'</div></div>').join('')||'<div class="hist">none</div>')+
    '<h3>run records</h3>'+(d.runs||[]).map(r=>'<pre>'+JSON.stringify(r.record,null,1)+'</pre>').join('');
  el.querySelector('h2').textContent=c.title||id;
  el.classList.add('open');
}
function closeCard(){document.getElementById('drawer').classList.remove('open')}
async function doTick(){
  const b=document.getElementById('tickbtn');b.classList.add('busy');b.textContent='ticking…';
  const r=await api('/api/tick','POST');
  b.classList.remove('busy');b.textContent='tick';
  const t=document.getElementById('toast');t.style.display='block';
  t.textContent='actions: '+r.actions+' · '+(r.ran||[]).map(x=>x.lane+':'+x.verdict).join(', ');
  setTimeout(()=>t.style.display='none',4000);
  refresh();
}
refresh();setInterval(refresh,2000);
`;

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>gk factory</title><style>${CSS}</style></head>
<body><header><h1>gk factory</h1><button id="tickbtn" onclick="doTick()">tick</button><span class="meta" id="ts"></span><span class="meta">click a card for journal · comments · run records</span></header>
<div class="board" id="board"></div>
<div class="drawer" id="drawer"></div>
<div style="padding:0 20px 30px"><h3 style="font-size:12px;text-transform:uppercase;color:#8b949e">lane runs</h3><div class="runs" id="runs"></div></div>
<div id="toast"></div><script>${JS}</script></body></html>`;

export function serveFactoryDashboard(
  cwd: string,
  cfg: FactoryConfig,
  prov: Providers,
  deps: TickDeps,
  port = 4173,
): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    try {
      if (url === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(HTML);
        return;
      }
      if (url === "/api/state") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(state(cwd)));
        return;
      }
      if (url === "/api/tick" && req.method === "POST") {
        const r = await tick(cwd, cfg, prov, deps);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(r));
        return;
      }
      const cardMatch = url.match(/^\/api\/card\/(.+)$/);
      if (cardMatch) {
        const id = cardMatch[1];
        const cards = readBoard(cwd);
        const card = cards.find((c) => c.id === id) ?? null;
        const journal = loadJournal(cwd, id);
        const runs = readRuns(cwd).filter((r) => r.record.card === id);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ card, journal, runs }));
        return;
      }
      res.writeHead(404);
      res.end("not found");
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  }).listen(port, () => {
    console.log(`factory dashboard → http://127.0.0.1:${port}`);
  });
}
