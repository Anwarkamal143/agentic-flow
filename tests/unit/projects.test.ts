/**
 * Projects are first-class (PRODUCT_SPEC §5, ADR-0055): a Project is named, never
 * created on the side, and inferred only when exactly one exists. A Project config
 * key is set one at a time, validated by the Project config schema. Pure; tested
 * through `@factory/domain`.
 */
import { chooseProject, setProjectConfigKey } from '@factory/domain';
import { describe, expect, it } from 'vitest';

const shop = { id: 'prj_1', name: 'shop' };
const blog = { id: 'prj_2', name: 'blog' };

describe('chooseProject', () => {
  it('finds a named Project by name or id', () => {
    expect(chooseProject([shop, blog], 'blog')).toEqual({ ok: true, project: blog });
    expect(chooseProject([shop, blog], 'prj_1')).toEqual({ ok: true, project: shop });
  });

  it('refuses an unknown name, listing the Projects', () => {
    expect(chooseProject([shop, blog], 'shpo')).toEqual({
      ok: false,
      code: 'project_not_found',
      message:
        "no Project 'shpo'. Projects: blog, shop. Create one with: factory project create shpo",
    });
  });

  it('infers the only Project when none is named', () => {
    expect(chooseProject([shop], undefined)).toEqual({ ok: true, project: shop });
  });

  it('refuses to infer from none or several Projects', () => {
    expect(chooseProject([], undefined)).toEqual({
      ok: false,
      code: 'no_projects',
      message: 'no Projects yet. Create one with: factory project create <name>',
    });
    expect(chooseProject([shop, blog], undefined)).toEqual({
      ok: false,
      code: 'project_required',
      message: 'there are several Projects (blog, shop); name one with --project',
    });
  });
});

describe('setProjectConfigKey', () => {
  it('sets a top-level and a nested key, leaving the rest', () => {
    expect(setProjectConfigKey({ maxAttempts: 2 }, 'planApproval', 'skip')).toEqual({
      ok: true,
      config: { maxAttempts: 2, planApproval: 'skip' },
    });
    expect(
      setProjectConfigKey({ concurrency: { perRepository: 3 } }, 'concurrency.perJob', 4),
    ).toEqual({ ok: true, config: { concurrency: { perRepository: 3, perJob: 4 } } });
  });

  it('does not change the config it was given', () => {
    const before = { concurrency: { perJob: 1 } };
    setProjectConfigKey(before, 'concurrency.perJob', 2);
    expect(before).toEqual({ concurrency: { perJob: 1 } });
  });

  it('refuses an unknown key, listing the known ones', () => {
    const result = setProjectConfigKey({}, 'colour', 'red');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unknown_config_key');
    expect(result.message).toContain("unknown Project config key 'colour'");
    expect(result.message).toContain('concurrency.perJob');
    expect(result.message).toContain('review.rerunOnBaseChange');
    expect(setProjectConfigKey({}, 'concurrency', { perJob: 2 }).ok).toBe(false);
  });

  it('refuses a value the schema refuses, naming the key', () => {
    const result = setProjectConfigKey({}, 'maxAttempts', 99);
    expect(result).toMatchObject({ ok: false, code: 'invalid_config_value' });
    if (result.ok) return;
    expect(result.message).toMatch(/^maxAttempts: /);
    expect(setProjectConfigKey({}, 'planApproval', 'sometimes').ok).toBe(false);
  });
});
