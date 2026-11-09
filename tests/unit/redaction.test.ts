/**
 * Redaction (ARCHITECTURE §17, #11): the values of secret environment
 * variables and known secret patterns are replaced before anything is stored
 * or streamed. Pure; tested through `@factory/domain`.
 */
import { createRedactor, secretsFromEnv } from '@factory/domain';
import { describe, expect, it } from 'vitest';

const TOKEN = 'tok-3f9a1c77e2b04d18';

describe('secretsFromEnv', () => {
  it('marks variables whose names say they hold a secret, and nothing else', () => {
    expect(
      secretsFromEnv({
        GH_TOKEN: TOKEN,
        ANTHROPIC_API_KEY: 'sk-live-0123456789',
        DB_PASSWORD: 'hunter2hunter2',
        MY_SERVICE_SECRET: 'abcdefghijkl',
        PATH: '/usr/bin:/bin',
        HOME: '/Users/someone',
        TOKEN_COUNT: '123456789012',
      }),
    ).toEqual([
      { name: 'GH_TOKEN', value: TOKEN },
      { name: 'ANTHROPIC_API_KEY', value: 'sk-live-0123456789' },
      { name: 'DB_PASSWORD', value: 'hunter2hunter2' },
      { name: 'MY_SERVICE_SECRET', value: 'abcdefghijkl' },
    ]);
  });

  it('skips values too short to redact without mangling ordinary text', () => {
    expect(secretsFromEnv({ GH_TOKEN: 'abc', GITHUB_TOKEN: '' })).toEqual([]);
  });
});

describe('createRedactor', () => {
  const redact = createRedactor([{ name: 'GH_TOKEN', value: TOKEN }]);

  it('replaces every occurrence of a secret value with its name', () => {
    expect(redact(`token=${TOKEN}\nagain ${TOKEN}.`)).toBe(
      'token=[REDACTED:GH_TOKEN]\nagain [REDACTED:GH_TOKEN].',
    );
  });

  it('leaves text without secrets unchanged', () => {
    expect(redact('nothing to see here')).toBe('nothing to see here');
  });

  it('replaces a secret value inside JSON text, where its special characters are escaped', () => {
    const quoted = createRedactor([{ name: 'DB_PASSWORD', value: 'pa"ss\\word\n9' }]);
    const json = JSON.stringify({ output: 'pw: pa"ss\\word\n9 end' });
    expect(quoted(json)).toBe(JSON.stringify({ output: 'pw: [REDACTED:DB_PASSWORD] end' }));
  });

  it('replaces the longer of two overlapping secret values whole', () => {
    const r = createRedactor([
      { name: 'SHORT_TOKEN', value: 'abcdefgh' },
      { name: 'LONG_TOKEN', value: 'abcdefgh-ijkl' },
    ]);
    expect(r('x abcdefgh-ijkl y abcdefgh')).toBe(
      'x [REDACTED:LONG_TOKEN] y [REDACTED:SHORT_TOKEN]',
    );
  });

  it.each([
    [
      'an AWS access key id',
      'key AKIAIOSFODNN7EXAMPLE end',
      'key [REDACTED:aws_access_key_id] end',
    ],
    ['a GitHub token', `gh ghp_${'a'.repeat(36)} end`, 'gh [REDACTED:github_token] end'],
    [
      'a fine-grained GitHub token',
      `gh github_pat_${'B'.repeat(30)} end`,
      'gh [REDACTED:github_token] end',
    ],
    ['an Anthropic key', `k sk-ant-api03-${'x'.repeat(40)} end`, 'k [REDACTED:anthropic_key] end'],
    [
      'a private key block',
      'a\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nIBAAK\n-----END RSA PRIVATE KEY-----\nb',
      'a\n[REDACTED:private_key]\nb',
    ],
    [
      'a private key block cut off by truncation',
      'a\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk',
      'a\n[REDACTED:private_key]',
    ],
  ])('replaces %s found by its pattern', (_what, text, expected) => {
    expect(createRedactor([])(text)).toBe(expected);
  });

  it('keeps JSON valid around a cut-off private key block', () => {
    const json = JSON.stringify({ output: '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nIBAA', n: 1 });
    expect(JSON.parse(createRedactor([])(json))).toEqual({
      output: '[REDACTED:private_key]',
      n: 1,
    });
  });

  it('is idempotent', () => {
    const once = redact(`${TOKEN} AKIAIOSFODNN7EXAMPLE`);
    expect(redact(once)).toBe(once);
  });
});
