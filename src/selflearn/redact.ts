// Egress redline: secret/PII redaction applied the moment text leaves the
// session — capture slices, recorded records, materialized evidence. Port of
// autoharness lib/redact.py + redaction_rules.toml (MIT); the rule set is
// embedded as data so no TOML dependency is needed. Each match is replaced
// wholesale with [REDACTED:<category>:<name>] — over-redaction is the safe
// side.

interface RedactRule {
  category: "secret" | "pii";
  name: string;
  pattern: RegExp;
  /** Optional gate: matches failing the check stay in the stream as evidence. */
  validate?: (match: string) => boolean;
}

function passesLuhn(text: string): boolean {
  const digits = text.replace(/\D/g, "");
  if (!digits) return false;
  let total = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    total += d;
  }
  return total % 10 === 0;
}

const RULES: RedactRule[] = [
  { category: "secret", name: "aws_access_key_id", pattern: /AKIA[0-9A-Z]{16}/g },
  { category: "secret", name: "private_key_block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { category: "secret", name: "github_token", pattern: /gh[posru]_[A-Za-z0-9]{20,}/g },
  { category: "secret", name: "slack_token", pattern: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { category: "secret", name: "bearer_token", pattern: /bearer\s+[A-Za-z0-9._-]{20,}/gi },
  {
    category: "secret",
    name: "api_key_assignment",
    pattern: /(api[_-]?key|secret|token|password)\s*[:=]\s*['"]?[A-Za-z0-9._\-/+]{12,}/gi,
  },
  { category: "pii", name: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { category: "pii", name: "ssn", pattern: /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g },
  { category: "pii", name: "us_phone", pattern: /(?<!\d)(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}(?!\d)/g },
  // luhn gate: digit runs failing the checksum (snowflake ids, timestamps,
  // numeric pks) stay in the stream as evidence; real card numbers pass.
  { category: "pii", name: "credit_card", pattern: /(?<!\d)(?:\d[ -]?){13,16}(?!\d)/g, validate: passesLuhn },
];

export function redact(text: string): string {
  // Two-phase: insert inert sentinels while rules run so no rule can match
  // inside a marker another rule just wrote, then expand to markers.
  const markers: string[] = [];
  let out = text;
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    out = out.replace(rule.pattern, (m) => {
      if (rule.validate && !rule.validate(m)) return m;
      markers.push(`[REDACTED:${rule.category}:${rule.name}]`);
      return `${markers.length - 1}`;
    });
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: inert sentinel bytes (\x01/\x02) are the point — they can never appear in or match a redaction marker
  return out.replace(/(\d+)/g, (_s, i) => markers[Number(i)]);
}

/** Names of the *secret* rules text matches — a gate, not a rewrite
 *  (PII stays redact-only; used by the promote lint as a hard reject). */
export function secretHits(text: string): string[] {
  const hits: string[] = [];
  for (const rule of RULES) {
    if (rule.category !== "secret") continue;
    rule.pattern.lastIndex = 0;
    for (const m of text.matchAll(rule.pattern)) {
      if (!rule.validate || rule.validate(m[0])) {
        hits.push(rule.name);
        break;
      }
    }
  }
  return hits;
}
