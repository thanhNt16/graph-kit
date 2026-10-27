/** `gk factory serve` — local dashboard over the factory's state files:
 *  Kanban board (lane columns), per-card drawer with progress stepper,
 *  journal + comments + run records, and an activity feed of lane runs.
 *  POST /api/tick runs one planner tick so the board moves while you watch.
 *  node:http, no deps — everything inline. */
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
:root{color-scheme:dark;
  --bg:#0a0a0d;--panel:#131318;--panel2:#1a1a21;--raise:#22222b;
  --line:rgba(255,255,255,.07);--line2:rgba(255,255,255,.12);
  --fg:#eceef2;--dim:#9a9aa8;--faint:#6d6d7c;
  --accent:#8b7cf6;--accent-soft:rgba(139,124,246,.16);
  --ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--info:#60a5fa;--teal:#2dd4bf;
  --r:10px;
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:var(--raise);border-radius:5px;border:2px solid var(--bg)}
::-webkit-scrollbar-track{background:transparent}

/* ---------- top bar ---------- */
header{display:flex;align-items:center;gap:16px;padding:14px 22px;border-bottom:1px solid var(--line);position:sticky;top:0;background:rgba(10,10,13,.85);backdrop-filter:blur(12px);z-index:20}
.logo{display:flex;align-items:center;gap:10px}
.logo .mark{width:26px;height:26px;border-radius:7px;background:linear-gradient(135deg,var(--accent),#5b4bd6);display:grid;place-items:center;font-weight:700;font-size:12px;color:#fff;letter-spacing:-.02em}
.logo .name{font-weight:650;font-size:15px;letter-spacing:-.01em}
.logo .name span{color:var(--dim);font-weight:450}
.cwd{color:var(--faint);font-size:12px}
.spacer{flex:1}
.live{display:flex;align-items:center;gap:7px;color:var(--dim);font-size:12px}
.live .dot{width:7px;height:7px;border-radius:50%;background:var(--ok);box-shadow:0 0 8px var(--ok);animation:breathe 2.6s ease-in-out infinite}
#ts{color:var(--faint);font-size:12px}
.btn-primary{background:var(--accent);color:#fff;border-radius:8px;padding:7px 18px;font-weight:600;font-size:13px;transition:background .15s,transform .1s,box-shadow .15s;box-shadow:0 1px 12px rgba(139,124,246,.25)}
.btn-primary:hover{background:#9b8ef8;box-shadow:0 1px 16px rgba(139,124,246,.4)}
.btn-primary:active{transform:translateY(1px)}
.btn-primary.busy{opacity:.65;pointer-events:none}
.btn-primary .spin{display:inline-block;width:11px;height:11px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;margin-right:7px;vertical-align:-1px;animation:rot .7s linear infinite}
@keyframes rot{to{transform:rotate(360deg)}}
@keyframes breathe{0%,100%{opacity:1}50%{opacity:.35}}

/* ---------- board ---------- */
.board{display:grid;grid-template-columns:repeat(6,minmax(215px,1fr));gap:12px;padding:18px 22px;align-items:start}
.lane{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);min-height:340px;display:flex;flex-direction:column;transition:border-color .2s}
.lane.flash{border-color:var(--line2)}
.lane-head{display:flex;align-items:center;gap:8px;padding:11px 13px;border-bottom:1px solid var(--line)}
.lane-head .cdot{width:8px;height:8px;border-radius:50%}
.lane-head h2{margin:0;font-size:11.5px;font-weight:650;text-transform:uppercase;letter-spacing:.09em;color:var(--dim)}
.lane-head .count{margin-left:auto;font-size:11px;color:var(--faint);background:var(--raise);border-radius:9px;padding:1px 8px;min-width:20px;text-align:center}
.lane-body{padding:8px;display:flex;flex-direction:column;gap:8px;flex:1}
.lane-body .empty{border:1px dashed var(--line2);border-radius:8px;padding:18px 10px;text-align:center;color:var(--faint);font-size:12px}

.card{background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:10px 12px;cursor:pointer;transition:border-color .15s,transform .15s,box-shadow .15s;animation:cardin .25s ease-out}
.card:hover{border-color:var(--line2);transform:translateY(-1px);box-shadow:0 4px 14px rgba(0,0,0,.35)}
.card.moved{animation:moved .9s ease-out}
@keyframes cardin{from{opacity:0;transform:translateY(5px)}}
@keyframes moved{0%{box-shadow:0 0 0 2px var(--accent);}100%{box-shadow:0 0 0 0 transparent}}
.card .top{display:flex;align-items:center;gap:8px;margin-bottom:5px}
.card .key{font-size:11px;color:var(--dim);background:var(--raise);padding:1px 7px;border-radius:6px}
.card .title{font-size:13px;font-weight:550;line-height:1.35;letter-spacing:-.005em}
.card .foot{display:flex;align-items:center;gap:6px;margin-top:8px;flex-wrap:wrap}
.chip{font-size:10.5px;padding:1px 8px;border-radius:9px;border:1px solid var(--line);color:var(--dim)}
.chip.halt{border-color:rgba(248,113,113,.4);color:var(--bad)}
.card .ago{margin-left:auto;font-size:10.5px;color:var(--faint)}

.pill{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;font-weight:600;padding:2px 9px;border-radius:20px;letter-spacing:.02em}
.pill .pdot{width:6px;height:6px;border-radius:50%;background:currentColor}
.pill.claimed,.pill.running{color:var(--info);background:rgba(96,165,250,.13)}
.pill.running .pdot{animation:breathe 1.4s ease-in-out infinite}
.pill.awaiting_advance{color:var(--warn);background:rgba(251,191,36,.12)}
.pill.blocked,.pill.parked{color:var(--bad);background:rgba(248,113,113,.12)}
.pill.done{color:var(--ok);background:rgba(74,222,128,.12)}
.pill.untracked{color:var(--faint);background:var(--raise)}
.v-MERGE{color:var(--ok)}.v-BLOCK{color:var(--bad)}
.vpill{font-size:10.5px;font-weight:650;padding:1px 9px;border-radius:20px;letter-spacing:.03em}
.vpill.MERGE{color:var(--ok);background:rgba(74,222,128,.12)}
.vpill.BLOCK{color:var(--bad);background:rgba(248,113,113,.12)}
.vpill.none{color:var(--faint);background:var(--raise)}

/* ---------- activity ---------- */
.activity{margin:4px 22px 34px;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);overflow:hidden}
.activity>h3{margin:0;padding:11px 15px;font-size:11.5px;font-weight:650;text-transform:uppercase;letter-spacing:.09em;color:var(--dim);border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px}
.activity table{width:100%;border-collapse:collapse;font-size:12.5px}
.activity th{font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--faint);font-weight:600;text-align:left;padding:8px 15px;border-bottom:1px solid var(--line)}
.activity td{padding:8px 15px;border-bottom:1px solid var(--line);vertical-align:middle}
.activity tr:last-child td{border-bottom:0}
.activity tr{transition:background .12s}
.activity tbody tr:hover{background:rgba(255,255,255,.025)}
.activity .note{color:var(--dim);max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.activity .when{color:var(--faint);font-size:11.5px;white-space:nowrap}
.activity .cid{color:var(--dim);font-size:11.5px}

/* ---------- drawer ---------- */
.backdrop{position:fixed;inset:0;background:rgba(0,0,0,.5);backdrop-filter:blur(2px);opacity:0;pointer-events:none;transition:opacity .2s;z-index:30}
.backdrop.open{opacity:1;pointer-events:auto}
.drawer{position:fixed;top:0;right:0;bottom:0;width:min(600px,94vw);background:var(--panel);border-left:1px solid var(--line2);z-index:40;transform:translateX(102%);transition:transform .28s cubic-bezier(.32,.72,.35,1);display:flex;flex-direction:column}
.drawer.open{transform:none}
.drawer-head{padding:18px 22px 14px;border-bottom:1px solid var(--line)}
.drawer-head .x{float:right;color:var(--dim);font-size:18px;padding:2px 8px;border-radius:6px;transition:background .15s}
.drawer-head .x:hover{background:var(--raise);color:var(--fg)}
.drawer-head h2{font-size:16px;margin:0 0 6px;font-weight:650;letter-spacing:-.01em;line-height:1.3}
.drawer-head .meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dim);font-size:12px}
.drawer-head .meta .kid{font-size:10.5px;color:var(--faint)}
.drawer-body{overflow-y:auto;padding:0 22px 30px;flex:1}
.drawer-body h3{font-size:11px;text-transform:uppercase;letter-spacing:.09em;color:var(--faint);margin:22px 0 10px;font-weight:650}

.stepper{display:flex;align-items:center;gap:0;margin-top:14px}
.step{display:flex;align-items:center;flex:1}
.step .sdot{width:22px;height:22px;border-radius:50%;background:var(--raise);border:1px solid var(--line2);display:grid;place-items:center;font-size:9.5px;color:var(--faint);flex:none;position:relative}
.step .slabel{position:absolute;top:26px;left:50%;transform:translateX(-50%);font-size:9.5px;color:var(--faint);white-space:nowrap}
.step.done .sdot{background:rgba(74,222,128,.15);border-color:rgba(74,222,128,.5);color:var(--ok)}
.step.done .slabel{color:var(--ok)}
.step.now .sdot{background:var(--accent-soft);border-color:var(--accent);color:var(--accent);box-shadow:0 0 0 4px rgba(139,124,246,.12)}
.step.now .sdot::after{content:"";position:absolute;inset:-4px;border-radius:50%;border:1px solid var(--accent);animation:pulse 1.6s ease-out infinite}
.step.now .slabel{color:var(--accent)}
.step .bar{flex:1;height:2px;background:var(--raise);margin:0 4px}
.step.done .bar{background:rgba(74,222,128,.4)}
@keyframes pulse{0%{opacity:.8;transform:scale(.8)}100%{opacity:0;transform:scale(1.5)}}
.stepper-wrap{padding-bottom:26px}

.hist{display:flex;flex-direction:column}
.hist .hrow{display:flex;gap:12px;position:relative;padding-bottom:14px}
.hist .hrow:last-child{padding-bottom:0}
.hist .rail{position:absolute;left:4px;top:14px;bottom:0;width:1px;background:var(--line2)}
.hist .hrow:last-child .rail{display:none}
.hist .hdot{width:9px;height:9px;border-radius:50%;margin-top:4px;flex:none;background:var(--raise);border:1px solid var(--line2)}
.hist .hrow.m .hdot{background:rgba(74,222,128,.2);border-color:var(--ok)}
.hist .hrow.b .hdot{background:rgba(248,113,113,.2);border-color:var(--bad)}
.hist .hbody{font-size:12.5px}
.hist .hbody .what{color:var(--fg)}
.hist .hbody .sub{color:var(--faint);font-size:11px;margin-top:1px}

.comment{border:1px solid var(--line);border-radius:9px;padding:10px 13px;margin:8px 0;font-size:12.5px;background:var(--panel2)}
.comment .who{color:var(--faint);font-size:11px;margin-bottom:4px;display:flex;justify-content:space-between}
.comment .body{white-space:pre-wrap;word-break:break-word;color:var(--dim)}
details.run{border:1px solid var(--line);border-radius:9px;margin:8px 0;background:var(--panel2);overflow:hidden}
details.run summary{padding:9px 13px;font-size:12px;cursor:pointer;list-style:none;display:flex;align-items:center;gap:10px;transition:background .12s}
details.run summary:hover{background:rgba(255,255,255,.03)}
details.run summary::-webkit-details-marker{display:none}
details.run summary .rid{color:var(--dim)}
details.run summary .when{margin-left:auto;color:var(--faint);font-size:11px}
details.run pre{margin:0;padding:12px 14px;border-top:1px solid var(--line);font-size:11px;overflow-x:auto;white-space:pre-wrap;word-break:break-word;color:var(--dim);background:var(--bg)}

.prline{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--accent);background:var(--accent-soft);padding:4px 11px;border-radius:7px}
.none{color:var(--faint);font-size:12.5px}

#toast{position:fixed;bottom:22px;left:50%;transform:translate(-50%,12px);background:var(--raise);border:1px solid var(--line2);border-radius:10px;padding:10px 18px;font-size:12.5px;opacity:0;pointer-events:none;transition:opacity .25s,transform .25s;z-index:50;box-shadow:0 8px 30px rgba(0,0,0,.5)}
#toast.show{opacity:1;transform:translate(-50%,0)}
#toast .vpill{margin-left:5px}

@media (max-width:1100px){.board{grid-template-columns:repeat(3,1fr)}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

const JS = `
const $=(s)=>document.querySelector(s);
const LANES=["ready","building","qa","review","blocked","done"];
const LANE_C={ready:"#60a5fa",building:"#bc8cff",qa:"#fbbf24",review:"#2dd4bf",blocked:"#f87171",done:"#4ade80"};
const FLOW=["ready","building","qa","review","done"];
const esc=(s)=>String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const rel=(iso)=>{if(!iso)return"";const s=(Date.now()-new Date(iso).getTime())/1e3;
  if(s<60)return"just now";if(s<3600)return Math.floor(s/60)+"m ago";if(s<86400)return Math.floor(s/3600)+"h ago";return Math.floor(s/86400)+"d ago"};
const hm=(iso)=>(iso||"").slice(11,19);
async function api(p,m){const r=await fetch(p,m?{method:m}:{});return r.json();}

const cardEls=new Map(); let knownLane={};
function pill(phase,round){const p=phase||"untracked";return '<span class="pill '+p+'"><span class="pdot"></span>'+p+(round?" · r"+round:"")+'</span>'}

function renderCard(c,j){
  let el=cardEls.get(c.id);
  if(!el){el=document.createElement("div");el.className="card";el.onclick=()=>openCard(c.id);cardEls.set(c.id,el)}
  el.innerHTML='<div class="top"><span class="key mono">'+esc(c.key)+'</span>'+pill(j.phase,j.round)+'</div>'+
    '<div class="title"></div>'+
    '<div class="foot">'+((c.labels||[]).map(l=>'<span class="chip'+(l.includes("halt")?" halt":"")+'">'+esc(l)+'</span>').join(""))+
    '<span class="ago">'+rel(c.updatedAt)+'</span></div>';
  el.querySelector(".title").textContent=c.title||"";
  return el;
}

async function refresh(){
  const s=await api("/api/state");
  const jmap=Object.fromEntries((s.journals||[]).map(j=>[j.card,j]));
  const board=$("#board");
  for(const lane of s.lanes){
    let col=board.querySelector('[data-lane="'+lane+'"]');
    if(!col){
      col=document.createElement("div");col.className="lane";col.dataset.lane=lane;
      col.innerHTML='<div class="lane-head"><span class="cdot" style="background:'+(LANE_C[lane]||"#888")+'"></span><h2>'+lane+'</h2><span class="count">0</span></div><div class="lane-body"></div>';
      board.appendChild(col);
    }
    const cards=s.cards[lane]||[];
    const body=col.querySelector(".lane-body");
    col.querySelector(".count").textContent=cards.length;
    const newIds=cards.map(c=>c.id);
    for(const el of [...body.querySelectorAll(".card")])if(!newIds.includes(el.dataset.id))el.remove();
    body.querySelector(".empty")?.remove();
    if(!cards.length){body.innerHTML='<div class="empty">no cards</div>'}
    else{
      cards.forEach(c=>{
        const el=renderCard(c,jmap[c.id]||{});
        el.dataset.id=c.id;
        if(knownLane[c.id]&&knownLane[c.id]!==lane){el.classList.remove("moved");void el.offsetWidth;el.classList.add("moved");col.classList.add("flash");setTimeout(()=>col.classList.remove("flash"),900)}
        body.appendChild(el);
        knownLane[c.id]=lane;
      });
      [...body.querySelectorAll(".card")].forEach(el=>{
        const want=cards.findIndex(c=>c.id===el.dataset.id);
        const ref=body.querySelectorAll(".card")[want];
        if(ref&&ref!==el)body.insertBefore(el,ref);
      });
    }
  }
  const runs=(s.runs||[]).map(r=>{
    const rec=r.record;const v=rec.verdict||"none";
    return '<tr><td><span class="cdot" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:'+(LANE_C[rec.lane]||"#888")+';margin-right:7px;vertical-align:1px"></span>'+esc(rec.lane)+'</td>'+
      '<td><span class="vpill '+v+'">'+v+'</span></td>'+
      '<td class="cid mono">'+esc((rec.card||"").slice(0,18))+'</td>'+
      '<td class="note">'+esc(rec.note||"")+'</td>'+
      '<td class="when mono">'+rel(rec.at)+'</td></tr>'}).join("");
  $("#runs").innerHTML=runs||'<tr><td colspan="5" class="none" style="padding:14px 15px">no lane runs yet</td></tr>';
  $("#ts").textContent="updated "+new Date().toLocaleTimeString();
}

function stepper(lane){
  const idx=FLOW.indexOf(lane);
  const eff=lane==="blocked"?-1:idx;
  return '<div class="stepper-wrap"><div class="stepper">'+FLOW.map((f,i)=>{
    const cls=i<eff?"done":i===eff?"now":"";
    return '<div class="step '+cls+'"><div class="sdot">'+(i<eff?"✓":i+1)+'<span class="slabel">'+f+'</span></div>'+(i<FLOW.length-1?'<div class="bar"></div>':"")+'</div>'}).join("")+'</div></div>';
}

async function openCard(id){
  const d=await api("/api/card/"+encodeURIComponent(id));
  const j=d.journal||{},c=d.card||{};
  const hist=(j.history||[]).map(h=>{
    const m=h.verdict==="MERGE"?"m":h.verdict==="BLOCK"?"b":"";
    return '<div class="hrow '+m+'"><span class="rail"></span><span class="hdot"></span><div class="hbody"><div class="what">'+
      esc(h.from||"∅")+' → <b>'+esc(h.to)+'</b> '+(h.verdict?'<span class="v-'+h.verdict+'">'+h.verdict+'</span>':"")+'</div>'+
      '<div class="sub">'+(h.note?esc(h.note)+" · ":"")+hm(h.at)+'</div></div></div>'}).join("");
  const comments=(c.comments||[]).map(m=>'<div class="comment"><div class="who"><span>'+esc(m.author||"gk-factory")+'</span><span>'+rel(m.createdAt)+'</span></div><div class="body">'+esc(m.body||"")+'</div></div>').join("");
  const runs=(d.runs||[]).map(r=>{const rec=r.record;const v=rec.verdict||"none";
    return '<details class="run"><summary><span class="vpill '+v+'">'+v+'</span><span class="rid mono">'+esc(rec.lane)+' · '+esc(rec.run_id||"")+'</span><span class="when">'+rel(rec.at)+'</span></summary><pre>'+esc(JSON.stringify(rec,null,2))+'</pre></details>'}).join("");
  const pr=j.pr?'<a class="prline" href="'+esc(j.pr.url)+'">↗ PR #'+j.pr.number+'</a>':"";
  $("#drawer").innerHTML=
    '<div class="drawer-head"><button class="x" onclick="closeCard()">✕</button>'+
    '<h2></h2><div class="meta"><span class="key mono" style="font-size:11px;background:var(--raise);padding:1px 7px;border-radius:6px">'+esc(c.key||"")+'</span>'+pill(j.phase,j.round)+'<span class="kid mono">'+esc(id)+'</span>'+pr+'</div>'+
    stepper(c.lane)+'</div>'+
    '<div class="drawer-body">'+
    '<h3>History</h3><div class="hist">'+(hist||'<div class="none">no transitions yet</div>')+'</div>'+
    '<h3>Comments</h3>'+(comments||'<div class="none">none</div>')+
    '<h3>Run records</h3>'+(runs||'<div class="none">none</div>')+'</div>';
  $("#drawer h2").textContent=c.title||id;
  $("#drawer").classList.add("open");$("#backdrop").classList.add("open");
}
function closeCard(){$("#drawer").classList.remove("open");$("#backdrop").classList.remove("open")}
document.addEventListener("keydown",e=>{if(e.key==="Escape")closeCard()});

let ticking=false;
async function doTick(){
  if(ticking)return;ticking=true;
  const b=$("#tickbtn");b.classList.add("busy");b.innerHTML='<span class="spin"></span>ticking';
  const r=await api("/api/tick","POST");
  b.classList.remove("busy");b.textContent="tick";ticking=false;
  const t=$("#toast");
  t.innerHTML='<span style="color:var(--dim)">'+r.actions+' action(s)</span>'+(r.ran||[]).map(x=>'<span class="vpill '+x.verdict+'" style="margin-left:8px">'+x.lane+' '+x.verdict+'</span>').join("");
  t.classList.add("show");setTimeout(()=>t.classList.remove("show"),4200);
  refresh();
}
$("#tickbtn").onclick=doTick;$("#backdrop").onclick=closeCard;
refresh();setInterval(()=>{if(!ticking)refresh()},2000);
`;

const HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>gk factory</title><style>${CSS}</style></head>
<body>
<header>
  <div class="logo"><span class="mark">gk</span><span class="name">graph-kit <span>/ factory</span></span></div>
  <div class="live"><span class="dot"></span>live</div>
  <span id="ts"></span>
  <div class="spacer"></div>
  <button id="tickbtn" class="btn-primary">tick</button>
</header>
<div class="board" id="board"></div>
<div class="activity"><h3>lane activity</h3><table><thead><tr><th style="width:110px">lane</th><th style="width:90px">verdict</th><th>card</th><th>note</th><th style="width:80px">when</th></tr></thead><tbody id="runs"></tbody></table></div>
<div class="backdrop" id="backdrop"></div>
<div class="drawer" id="drawer"></div>
<div id="toast"></div>
<script>${JS}</script>
</body></html>`;

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
        const id = decodeURIComponent(cardMatch[1]);
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
