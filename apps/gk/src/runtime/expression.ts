import { GraphKitError } from "../errors.js";

// Bounded expression grammar (non-Turing-complete):
//   expr     := or
//   or       := and ( '||' and )*
//   and      := not ( '&&' not )*
//   not      := '!' not | comparison
//   comparison := primary ( '==' | '!=' | '>=' | '<=' | '>' | '<' primary )?
//   primary  := root '.' ident ( '.' ident )* | 'null' | 'true' | 'false' | string | number | '(' expr ')'
//   root     := 'inputs' | 'state' | 'nodes' | 'run' | 'limits'
// No calls, assignment, arithmetic, brackets, or unknown roots.

export type Scope = Record<string, unknown>;

type Token = { type: "ident" | "string" | "number" | "op" | "lparen" | "rparen" | "dot" | "eof"; value: string };

const WHITESPACE = /\s/;

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (WHITESPACE.test(c)) {
      i++;
      continue;
    }
    if (c === "(") {
      tokens.push({ type: "lparen", value: c });
      i++;
      continue;
    }
    if (c === ")") {
      tokens.push({ type: "rparen", value: c });
      i++;
      continue;
    }
    if (c === ".") {
      tokens.push({ type: "dot", value: c });
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      let value = "";
      let j = i + 1;
      while (j < src.length && src[j] !== quote) {
        value += src[j];
        j++;
      }
      if (j >= src.length) throw unsupported("unterminated string");
      tokens.push({ type: "string", value });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      tokens.push({ type: "number", value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[=!<>|&]/.test(c)) {
      // longest match of two-char operators first
      const two = src.slice(i, i + 2);
      if (["==", "!=", ">=", "<=", "&&", "||"].includes(two)) {
        tokens.push({ type: "op", value: two });
        i += 2;
        continue;
      }
      if (["!", ">", "<"].includes(c)) {
        tokens.push({ type: "op", value: c });
        i++;
        continue;
      }
      throw unsupported(`unexpected operator '${c}'`);
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[a-zA-Z_0-9]/.test(src[j])) j++;
      tokens.push({ type: "ident", value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw unsupported(`unexpected character '${c}'`);
  }
  tokens.push({ type: "eof", value: "" });
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }
  private next(): Token {
    return this.tokens[this.pos++];
  }

  parse(): Node {
    const node = this.or();
    if (this.peek().type !== "eof") throw unsupported("unexpected trailing tokens");
    return node;
  }

  private or(): Node {
    let left = this.and();
    while (this.peek().type === "op" && this.peek().value === "||") {
      this.next();
      const right = this.and();
      left = { kind: "or", left, right };
    }
    return left;
  }

  private and(): Node {
    let left = this.not();
    while (this.peek().type === "op" && this.peek().value === "&&") {
      this.next();
      const right = this.not();
      left = { kind: "and", left, right };
    }
    return left;
  }

  private not(): Node {
    if (this.peek().type === "op" && this.peek().value === "!") {
      this.next();
      return { kind: "not", operand: this.not() };
    }
    return this.comparison();
  }

  private comparison(): Node {
    const left = this.primary();
    const t = this.peek();
    if (t.type === "op" && ["==", "!=", ">=", "<=", ">", "<"].includes(t.value)) {
      this.next();
      const right = this.primary();
      return { kind: "cmp", op: t.value, left, right };
    }
    return left;
  }

  private primary(): Node {
    const t = this.peek();
    if (t.type === "lparen") {
      this.next();
      const inner = this.or();
      if (this.peek().type !== "rparen") throw unsupported("expected ')'");
      this.next();
      return inner;
    }
    if (t.type === "op" && t.value === "!") throw unsupported("misplaced '!'");
    if (t.type === "ident") {
      this.next();
      if (t.value === "null") return { kind: "lit", value: null };
      if (t.value === "true") return { kind: "lit", value: true };
      if (t.value === "false") return { kind: "lit", value: false };
      const ROOTS = ["inputs", "state", "nodes", "run", "limits"];
      if (!ROOTS.includes(t.value)) throw unsupported(`unknown root '${t.value}'`);
      const path: string[] = [t.value];
      while (this.peek().type === "dot") {
        this.next();
        const prop = this.next();
        if (prop.type !== "ident") throw unsupported("expected property name after '.'");
        path.push(prop.value);
      }
      return { kind: "ref", path };
    }
    if (t.type === "string") {
      this.next();
      return { kind: "lit", value: t.value };
    }
    if (t.type === "number") {
      this.next();
      return { kind: "lit", value: Number(t.value) };
    }
    throw unsupported("expected expression");
  }
}

type Node =
  | { kind: "ref"; path: string[] }
  | { kind: "lit"; value: unknown }
  | { kind: "not"; operand: Node }
  | { kind: "and"; left: Node; right: Node }
  | { kind: "or"; left: Node; right: Node }
  | { kind: "cmp"; op: string; left: Node; right: Node };

function unsupported(message: string): GraphKitError {
  return new GraphKitError("ERR_EXPRESSION", message);
}

function resolvePath(root: string, path: string[], scope: Scope): unknown {
  let value: unknown = scope[root];
  for (let i = 1; i < path.length; i++) {
    if (value === null || value === undefined) return null;
    value = (value as Record<string, unknown>)[path[i]];
  }
  return value === undefined ? null : value;
}

function evalNode(node: Node, scope: Scope): unknown {
  switch (node.kind) {
    case "lit":
      return node.value;
    case "ref":
      return resolvePath(node.path[0], node.path, scope);
    case "not":
      return !truthy(evalNode(node.operand, scope));
    case "and":
      return truthy(evalNode(node.left, scope)) && truthy(evalNode(node.right, scope));
    case "or":
      return truthy(evalNode(node.left, scope)) || truthy(evalNode(node.right, scope));
    case "cmp": {
      const a = evalNode(node.left, scope);
      const b = evalNode(node.right, scope);
      switch (node.op) {
        case "==":
          return looseEqual(a, b);
        case "!=":
          return !looseEqual(a, b);
        case ">":
          return compare(a, b) > 0;
        case ">=":
          return compare(a, b) >= 0;
        case "<":
          return compare(a, b) < 0;
        case "<=":
          return compare(a, b) <= 0;
      }
    }
  }
}

function truthy(value: unknown): boolean {
  return Boolean(value);
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (typeof a === "string" && typeof b === "string") return a === b;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b;
  return a === b;
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  throw unsupported("cannot compare non-numeric values");
}

export function evaluateCondition(expression: string, scope: Scope): boolean {
  const cleaned = expression.trim();
  if (cleaned === "") return true;
  const ast = new Parser(tokenize(cleaned)).parse();
  return truthy(evalNode(ast, scope));
}

export function resolveTemplate(value: unknown, scope: Scope): unknown {
  if (typeof value === "string") {
    const exact = /^\${{(.+?)}}$/.exec(value.trim());
    if (exact) {
      const ast = new Parser(tokenize(exact[1].trim())).parse();
      return evalNode(ast, scope);
    }
    return value.replace(/\${{(.+?)}}/g, (_match, inner: string) => {
      const ast = new Parser(tokenize(inner.trim())).parse();
      const resolved = evalNode(ast, scope);
      return resolved === null || resolved === undefined ? "null" : String(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((item) => resolveTemplate(item, scope));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = resolveTemplate(child, scope);
    }
    return out;
  }
  return value;
}
