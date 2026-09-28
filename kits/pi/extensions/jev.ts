import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Jev (TypeSafe System One) tool for omp.
//
// Jev is not a chat model: POST {state, questions} -> typed answers with
// calibrated probabilities. 9router only proxies OpenAI-style chat
// completions, so it cannot carry /v1/systemone. This tool calls the System
// One endpoint directly — OpenRouter's by default — and resolves the API key
// from env first, then from the openrouter connection stored in 9router's db.

export interface JevQuestion {
  name: string;
  type: "noul" | "choice" | "score";
  instructions: string;
  /** choice: {optionLabel: description}; score: {level: description} */
  criteria?: Record<string, string>;
}

export interface JevDecideArgs {
  state: string;
  questions: JevQuestion[];
  model?: string;
  timeout_ms?: number;
}

export interface JevDecideResult {
  ok: boolean;
  model?: string;
  provider?: string;
  answers?: Record<string, unknown>;
  usage?: unknown;
  error?: string;
}

const OPENROUTER_BASE = "https://openrouter.ai/api";
const TYPESAFE_BASE = "https://api.typesafe.ai";
const NINE_ROUTER_DB = join(homedir(), ".9router", "db", "data.sqlite");

let cachedKey: string | null | undefined;

/** TYPESAFE_API_KEY -> OPENROUTER_API_KEY -> openrouter key in 9router's db. */
export function resolveApiKey(): string | null {
  if (cachedKey !== undefined) return cachedKey;
  const env = process.env.TYPESAFE_API_KEY ?? process.env.OPENROUTER_API_KEY;
  if (env) {
    cachedKey = env;
    return cachedKey;
  }
  cachedKey = null;
  if (existsSync(NINE_ROUTER_DB)) {
    try {
      const out = execFileSync(
        "sqlite3",
        [
          NINE_ROUTER_DB,
          "SELECT json_extract(data,'$.apiKey') FROM providerConnections WHERE provider='openrouter' AND isActive=1 LIMIT 1;",
        ],
        { encoding: "utf8", timeout: 5000 },
      ).trim();
      if (out) cachedKey = out;
    } catch {
      // sqlite3 missing or db locked — fall through to null
    }
  }
  return cachedKey;
}

/** TYPESAFE_BASE_URL wins; a TypeSafe key implies api.typesafe.ai; else OpenRouter. */
export function resolveBaseUrl(): string {
  if (process.env.TYPESAFE_BASE_URL) return process.env.TYPESAFE_BASE_URL.replace(/\/$/, "");
  if (process.env.TYPESAFE_API_KEY) return TYPESAFE_BASE;
  return OPENROUTER_BASE;
}

export function buildRequest(args: JevDecideArgs): { url: string; body: string } {
  const questions: Record<string, unknown> = {};
  for (const q of args.questions) {
    const spec: Record<string, unknown> = { type: q.type, instructions: q.instructions };
    if (q.criteria && Object.keys(q.criteria).length) spec.criteria = q.criteria;
    questions[q.name] = spec;
  }
  return {
    url: `${resolveBaseUrl()}/v1/systemone`,
    body: JSON.stringify({ model: args.model ?? "jev-latest", state: args.state, questions }),
  };
}

export async function decide(args: JevDecideArgs): Promise<JevDecideResult> {
  const key = resolveApiKey();
  if (!key) {
    return {
      ok: false,
      error: "No API key. Set TYPESAFE_API_KEY or OPENROUTER_API_KEY, or add an openrouter connection in 9router.",
    };
  }
  const { url, body } = buildRequest(args);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(args.timeout_ms ?? 30_000),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `[${res.status}]: ${text.slice(0, 500)}` };
    const json = JSON.parse(text) as {
      model?: string;
      provider?: string;
      answers?: Record<string, unknown>;
      usage?: unknown;
    };
    return { ok: true, model: json.model, provider: json.provider, answers: json.answers, usage: json.usage };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Registration targets the pi extension API (registerTool + typebox schema),
// same pattern as gk-subagent.ts. Pure functions above stay importable in
// unit tests without a pi/typebox runtime.
interface MinimalPiAPI {
  registerTool(tool: {
    name: string;
    label?: string;
    description?: string;
    parameters: unknown;
    execute: (
      toolCallId: string,
      params: JevDecideArgs,
      signal: AbortSignal,
      onUpdate: unknown,
      ctx: unknown,
    ) => Promise<{ content: { type: string; text: string }[]; details?: unknown }>;
  }): void;
}

export default async function jevExtension(pi: MinimalPiAPI): Promise<void> {
  // Dynamic import: unit tests import the pure functions above in plain bun,
  // where the pi runtime's typebox dependency is not installed.
  const { Type } = (await import("typebox")) as {
    Type: {
      Object: (props: Record<string, unknown>, opts?: unknown) => unknown;
      String: (opts?: unknown) => unknown;
      Number: (opts?: unknown) => unknown;
      Array: (schema: unknown, opts?: unknown) => unknown;
      Optional: (schema: unknown, opts?: unknown) => unknown;
      Union: (schemas: unknown[], opts?: unknown) => unknown;
      Literal: (value: string, opts?: unknown) => unknown;
      Record: (key: unknown, value: unknown, opts?: unknown) => unknown;
    };
  };

  pi.registerTool({
    name: "jev_decide",
    label: "Jev Decide",
    description:
      "Evaluate a state against typed questions with Jev (TypeSafe System One) via OpenRouter. " +
      "Returns calibrated typed answers — noul: p(yes); choice: pick + distribution; score: expected level. " +
      "Use for classification, routing, gating, and judging instead of asking a chat LLM. " +
      "All questions are answered in one parallel call (~70-500ms); the model cannot emit free text.",
    parameters: Type.Object({
      state: Type.String({ description: "Text or JSON string the questions are evaluated against" }),
      questions: Type.Array(
        Type.Object({
          name: Type.String({ description: "Answer key" }),
          type: Type.Union([Type.Literal("noul"), Type.Literal("choice"), Type.Literal("score")], {
            description: "noul=yes/no, choice=1-of-N, score=ordered rubric",
          }),
          instructions: Type.String({ description: "What the question asks" }),
          criteria: Type.Optional(
            Type.Record(Type.String(), Type.String(), {
              description:
                "choice: {option: description} (<=255); score: {level: description} (ordered, <=256). Omit for noul.",
            }),
          ),
        }),
        { description: "Typed questions evaluated in parallel on the same state" },
      ),
      model: Type.Optional(Type.String({ description: "jev-latest (default) or jev-1.13" })),
      timeout_ms: Type.Optional(Type.Number({ description: "Request budget, default 30000" })),
    }),
    async execute(_toolCallId, params) {
      const result = await decide(params);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });
}
