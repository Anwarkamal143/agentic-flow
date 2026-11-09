/**
 * The Tier 0 tool policy (ARCHITECTURE §11): what each Role's Harness Run may
 * use, frozen into the Effective Configuration. Pure; tested through
 * `@factory/domain`.
 */
import {
  DEFAULT_TOOL_POLICIES,
  EffectiveConfigSchema,
  HarnessRoleSchema,
  resolveEffectiveConfig,
  toolsOf,
} from '@factory/domain';
import { describe, expect, it } from 'vitest';

const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'];

describe('the recipe tool policies', () => {
  it('give every Role a policy', () => {
    for (const role of HarnessRoleSchema.options) expect(DEFAULT_TOOL_POLICIES[role]).toBeDefined();
  });

  it('let no proposal Role or the reviewer write, and none run a shell but the developer and the reviewer', () => {
    for (const role of ['triager', 'researcher', 'specifier', 'planner', 'reviewer'] as const) {
      const tools = toolsOf(DEFAULT_TOOL_POLICIES[role]);
      for (const write of WRITE_TOOLS) expect(tools).not.toContain(write);
    }
    for (const role of ['triager', 'researcher', 'specifier', 'planner'] as const) {
      expect(toolsOf(DEFAULT_TOOL_POLICIES[role])).not.toContain('Bash');
    }
  });

  it('limit the reviewer shell to reading git', () => {
    const shell = DEFAULT_TOOL_POLICIES.reviewer.allow.filter((r) => r.startsWith('Bash'));
    expect(shell.length).toBeGreaterThan(0);
    for (const rule of shell) expect(rule).toMatch(/^Bash\(git (diff|log|show|status):\*\)$/);
  });

  it('deny the developer pushing, history rewrites and the network', () => {
    const { deny } = DEFAULT_TOOL_POLICIES.developer;
    for (const rule of [
      'Bash(git push:*)',
      'Bash(git reset --hard:*)',
      'Bash(curl:*)',
      'WebFetch',
      'WebSearch',
    ]) {
      expect(deny).toContain(rule);
    }
  });

  it('are frozen into the Effective Configuration at the recipe level', () => {
    const config = resolveEffectiveConfig({ project: { maxAttempts: 2 } });
    expect(config.toolPolicies).toEqual({ value: DEFAULT_TOOL_POLICIES, source: 'recipe' });
  });

  it('are given to a Job frozen before they existed', () => {
    const old = EffectiveConfigSchema.parse({ maxAttempts: { value: 3, source: 'recipe' } });
    expect(old.toolPolicies.value).toEqual(DEFAULT_TOOL_POLICIES);
  });
});

describe('toolsOf', () => {
  it('names each tool once, from plain and scoped rules alike', () => {
    expect(
      toolsOf({ allow: ['Read', 'Bash(git diff:*)', 'Bash(git log:*)', 'Grep'], deny: [] }),
    ).toEqual(['Read', 'Bash', 'Grep']);
  });
});
