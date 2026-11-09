/**
 * The path-scope Gate (ARCHITECTURE §7 step 3): every path a Task's diff
 * touches must match a `writable` glob and no `forbidden` glob. Git reports a
 * rename as a deletion and an addition, so both paths are judged. Pure;
 * tested through `@factory/domain`.
 */
import { checkPathScope, type PathChange } from '@factory/domain';
import { describe, expect, it } from 'vitest';

const scope = {
  writable: ['src/**', 'test/**', 'README.md'],
  forbidden: ['package.json', '.github/**', 'src/generated/**'],
};

const change = (path: string, kind: PathChange['kind'] = 'modified'): PathChange => ({
  path,
  kind,
});

describe('The path-scope Gate', () => {
  it('passes a diff that stays inside the writable scope, nested paths included', () => {
    expect(
      checkPathScope(
        [change('src/math.ts'), change('src/deep/nested/dir/x.ts', 'added'), change('README.md')],
        scope,
      ),
    ).toEqual([]);
  });

  it('fails a forbidden path, naming the rule, the path and the glob it matched', () => {
    const [violation, ...rest] = checkPathScope(
      [change('src/math.ts'), change('package.json')],
      scope,
    );
    expect(rest).toEqual([]);
    expect(violation).toMatchObject({
      rule: 'scope.forbidden',
      paths: ['package.json'],
    });
    expect(violation?.message).toContain('package.json (modified, matches forbidden package.json)');
  });

  it('fails a path outside every writable glob', () => {
    expect(checkPathScope([change('lib/other.ts', 'added')], scope)).toEqual([
      {
        rule: 'scope.outside_writable',
        paths: ['lib/other.ts'],
        message:
          'the diff touches paths outside the writable scope (src/**, test/**, README.md): lib/other.ts (added)',
      },
    ]);
  });

  it('reports a path that is both writable and forbidden as forbidden only', () => {
    expect(checkPathScope([change('src/generated/api.ts')], scope)).toMatchObject([
      { rule: 'scope.forbidden', paths: ['src/generated/api.ts'] },
    ]);
  });

  it('judges dotfiles like any other path', () => {
    expect(
      checkPathScope(
        [change('test/.env.test', 'added'), change('.github/workflows/ci.yml')],
        scope,
      ),
    ).toMatchObject([{ rule: 'scope.forbidden', paths: ['.github/workflows/ci.yml'] }]);
    expect(checkPathScope([change('.eslintrc.json', 'added')], scope)).toMatchObject([
      { rule: 'scope.outside_writable', paths: ['.eslintrc.json'] },
    ]);
  });

  it('judges deletions: deleting a forbidden file is a violation', () => {
    const [violation] = checkPathScope([change('.github/CODEOWNERS', 'deleted')], scope);
    expect(violation).toMatchObject({ rule: 'scope.forbidden', paths: ['.github/CODEOWNERS'] });
    expect(violation?.message).toContain('.github/CODEOWNERS (deleted');
  });

  it('judges both sides of a rename: moving a file out of the scope, or a forbidden file into it', () => {
    // Git with --no-renames reports `git mv src/a.ts lib/a.ts` as these two changes.
    expect(
      checkPathScope([change('src/a.ts', 'deleted'), change('lib/a.ts', 'added')], scope),
    ).toMatchObject([{ rule: 'scope.outside_writable', paths: ['lib/a.ts'] }]);
    expect(
      checkPathScope(
        [change('package.json', 'deleted'), change('src/package.json', 'added')],
        scope,
      ),
    ).toMatchObject([{ rule: 'scope.forbidden', paths: ['package.json'] }]);
  });

  it('lists every offending path of a rule, sorted, once', () => {
    const violations = checkPathScope(
      [change('lib/b.ts'), change('package.json'), change('lib/a.ts'), change('lib/a.ts')],
      scope,
    );
    expect(violations.map((v) => [v.rule, v.paths])).toEqual([
      ['scope.forbidden', ['package.json']],
      ['scope.outside_writable', ['lib/a.ts', 'lib/b.ts']],
    ]);
  });

  it('matches globs against the whole path, case-sensitively', () => {
    expect(checkPathScope([change('Src/math.ts'), change('xsrc/math.ts')], scope)).toMatchObject([
      { rule: 'scope.outside_writable', paths: ['Src/math.ts', 'xsrc/math.ts'] },
    ]);
  });
});
