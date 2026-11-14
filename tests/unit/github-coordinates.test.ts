/**
 * GitHub coordinates and the token reference (#54): where a Repository lives
 * on GitHub, and how the factory finds the token it calls GitHub with. Pure;
 * tested through `@factory/domain`.
 */
import {
  coordinatesFromRemoteUrl,
  formatCoordinates,
  parseCoordinates,
  parseTokenReference,
} from '@factory/domain';
import { describe, expect, it } from 'vitest';

describe('coordinatesFromRemoteUrl', () => {
  it.each([
    ['https://github.com/acme/tiny-ts.git', 'acme/tiny-ts'],
    ['https://github.com/acme/tiny-ts', 'acme/tiny-ts'],
    ['https://github.com/acme/tiny-ts/', 'acme/tiny-ts'],
    ['https://GitHub.com/Acme/Tiny.TS.git', 'Acme/Tiny.TS'],
    ['http://github.com/acme/tiny-ts.git', 'acme/tiny-ts'],
    ['git@github.com:acme/tiny-ts.git', 'acme/tiny-ts'],
    ['git@github.com:acme/tiny-ts', 'acme/tiny-ts'],
    ['ssh://git@github.com/acme/tiny-ts.git', 'acme/tiny-ts'],
    ['ssh://git@github.com:22/acme/tiny-ts.git', 'acme/tiny-ts'],
    ['git://github.com/acme/tiny-ts.git', 'acme/tiny-ts'],
  ])('reads %s as %s', (url, expected) => {
    const coordinates = coordinatesFromRemoteUrl(url);
    expect(coordinates === null ? null : formatCoordinates(coordinates)).toBe(expected);
  });

  it.each([
    ['another host', 'https://gitlab.com/acme/tiny-ts.git'],
    ['a look-alike host', 'https://github.com.evil.example/acme/tiny-ts.git'],
    ['a GitHub Enterprise host', 'git@github.acme.internal:acme/tiny-ts.git'],
    ['a local path', '/srv/git/tiny-ts.git'],
    ['a relative path', '../upstream.git'],
    ['a file URL', 'file:///srv/git/tiny-ts.git'],
    ['a path deeper than owner/name', 'https://github.com/acme/tiny-ts/tree/main'],
    ['no repository name', 'https://github.com/acme'],
    ['an invalid owner', 'https://github.com/-acme/tiny-ts.git'],
  ])('gives no coordinates for %s', (_what, url) => {
    expect(coordinatesFromRemoteUrl(url)).toBeNull();
  });
});

describe('parseCoordinates', () => {
  it('accepts owner/name as given at repo add --github', () => {
    expect(parseCoordinates('acme/tiny-ts')).toEqual({
      ok: true,
      coordinates: { owner: 'acme', name: 'tiny-ts' },
    });
  });

  it.each(['acme', 'acme/', '/tiny-ts', 'acme/tiny-ts/extra', 'ac me/tiny', 'acme/..', 'acme/a?b'])(
    'refuses %s',
    (text) => {
      const parsed = parseCoordinates(text);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain('owner/name');
    },
  );
});

describe('parseTokenReference', () => {
  it('reads gh as the gh login', () => {
    expect(parseTokenReference('gh')).toEqual({ ok: true, reference: { kind: 'gh' } });
  });

  it('reads env:NAME as an environment variable', () => {
    expect(parseTokenReference('env:GH_ACCESS')).toEqual({
      ok: true,
      reference: { kind: 'env', name: 'GH_ACCESS' },
    });
  });

  it.each(['', 'env:', 'env:1ABC', 'env:A-B', 'ghp_abcdef', 'file:/tmp/token', 'GH'])(
    'refuses %s, so a token value is never mistaken for a reference',
    (text) => {
      expect(parseTokenReference(text).ok).toBe(false);
    },
  );
});
