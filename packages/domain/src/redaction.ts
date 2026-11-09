/**
 * Redaction (ARCHITECTURE §17): secret values never reach history. A
 * Redactor replaces the values of secret environment variables, and text that
 * matches a known secret pattern, with `[REDACTED:<name>]`. The runtime
 * applies it before anything is stored or streamed (ADR-0011). Pure.
 */

/** A secret value, named for the replacement (an environment variable's name). */
export interface Secret {
  readonly name: string;
  readonly value: string;
}

/** Replaces every secret in `text`. Idempotent. */
export type Redactor = (text: string) => string;

/** Shorter values are not redacted: replacing them would mangle ordinary text. */
export const MIN_SECRET_LENGTH = 8;

/** A variable is marked secret when its name ends in one of these words. */
const SECRET_NAME =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)$/i;

/** Known secret patterns, by name. The full corpus is Phase E (E3). */
const PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  {
    name: 'private_key',
    // Also a block cut off by output truncation: BEGIN and the key body after it
    // (base64 and line breaks, also JSON-escaped), so the JSON around it stays valid.
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----|(?:[A-Za-z0-9+/=\s]|\\[nr])*)/g,
  },
  { name: 'aws_access_key_id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { name: 'github_token', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { name: 'anthropic_key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
];

/**
 * The variables of `env` marked secret by their name (`*_TOKEN`, `*_SECRET`,
 * `*_PASSWORD`, `*_API_KEY`, …) whose values are long enough to redact.
 */
export function secretsFromEnv(env: Readonly<Record<string, string | undefined>>): Secret[] {
  const secrets: Secret[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value.length < MIN_SECRET_LENGTH) continue;
    if (SECRET_NAME.test(name)) secrets.push({ name, value });
  }
  return secrets;
}

/**
 * A Redactor for `secrets` and the known patterns. A value is matched both
 * as is and as it appears inside a JSON string, so stored JSON is covered
 * too. Longer values are replaced first, so overlapping secrets go whole.
 */
export function createRedactor(secrets: readonly Secret[]): Redactor {
  const literals: { text: string; replacement: string }[] = [];
  for (const s of secrets) {
    if (s.value.length < MIN_SECRET_LENGTH) continue;
    const replacement = `[REDACTED:${s.name}]`;
    literals.push({ text: s.value, replacement });
    const escaped = JSON.stringify(s.value).slice(1, -1);
    if (escaped !== s.value) literals.push({ text: escaped, replacement });
  }
  literals.sort((a, b) => b.text.length - a.text.length);
  return (text) => {
    let out = text;
    for (const l of literals) if (out.includes(l.text)) out = out.split(l.text).join(l.replacement);
    for (const p of PATTERNS) out = out.replace(p.pattern, `[REDACTED:${p.name}]`);
    return out;
  };
}
