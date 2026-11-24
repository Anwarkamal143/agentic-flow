/**
 * The clarification engine for proposal Stages (PRODUCT_SPEC §5, Phase D Q14,
 * ADR-0071): triage and specification output categorized questions, and plain
 * code routes them. Discoverable: the Stage re-runs once, then blocks without
 * asking. Technical: the agent decides (a Decision Record). Product, Security
 * and Operational: one Inbox Question batch, grouped by category, each with
 * options and a recommended default, capped by `maxQuestions` per Stage. Pure;
 * tested through `@factory/domain`.
 */
import {
  clarificationIssues,
  decisionRecordsOf,
  routeClarification,
  SpecificationProposalSchema,
  TriageProposalSchema,
  type ClarificationQuestion,
} from '@factory/domain';
import { describe, expect, it } from 'vitest';

const discoverable: ClarificationQuestion = {
  category: 'discoverable',
  text: 'Which test framework does the Repository use?',
  options: [],
};
const technical: ClarificationQuestion = {
  category: 'technical',
  text: 'Which hashing library?',
  options: ['bcrypt', 'argon2'],
  decision: 'argon2',
  rationale: 'It is the current OWASP recommendation.',
};
const product: ClarificationQuestion = {
  category: 'product',
  text: 'Should reset links expire in 1 h or 24 h?',
  options: ['1h', '24h'],
  recommended: '1h',
};
const security: ClarificationQuestion = {
  category: 'security',
  text: 'Allow writes under infra/?',
  options: ['allow', 'deny'],
  recommended: 'deny',
};
const operational: ClarificationQuestion = {
  category: 'operational',
  text: 'Increase the concurrency limit?',
  options: ['keep', 'raise to 4'],
  recommended: 'keep',
};

const fresh = { discoveryRerunUsed: false, batchesUsed: 0, maxQuestions: 3 };

describe('routing a proposal Stage’s questions', () => {
  it('a Stage with no questions proceeds', () => {
    expect(routeClarification({ ...fresh, questions: [] })).toEqual({ kind: 'proceed' });
  });

  it('a Technical question is the agent’s to decide: the Stage proceeds', () => {
    expect(routeClarification({ ...fresh, questions: [technical] })).toEqual({ kind: 'proceed' });
  });

  it('a Discoverable question re-runs the Stage once, never asking a human', () => {
    const route = routeClarification({ ...fresh, questions: [discoverable, product] });
    expect(route).toEqual({ kind: 'discover', questions: [discoverable.text] });
  });

  it('a Discoverable question still open after the re-run blocks the Stage with no Question', () => {
    const route = routeClarification({
      ...fresh,
      discoveryRerunUsed: true,
      questions: [discoverable, product],
    });
    expect(route.kind).toBe('blocked');
    if (route.kind !== 'blocked') return;
    expect(route.blocker.reason).toBe('discoverable_unresolved');
    expect(route.blocker.kind).toBe('policy');
    expect(route.blocker.detail).toContain('Which test framework does the Repository use?');
  });

  it('Product, Security and Operational questions are one batch, grouped by category', () => {
    const route = routeClarification({
      ...fresh,
      questions: [operational, technical, security, product],
    });
    expect(route.kind).toBe('ask');
    if (route.kind !== 'ask') return;
    expect(route.questions.map((q) => [q.id, q.category, q.text])).toEqual([
      ['q1', 'product', product.text],
      ['q2', 'security', security.text],
      ['q3', 'operational', operational.text],
    ]);
    expect(route.questions.map((q) => q.recommended)).toEqual(['1h', 'deny', 'keep']);
    expect(route.questions.every((q) => q.source === 'clarification' && q.agentProposed)).toBe(
      true,
    );
    expect(route.questions.every((q) => q.blocking)).toBe(true);
  });

  it('a Security question is marked as needing approver rights; the others are not', () => {
    const route = routeClarification({ ...fresh, questions: [product, security, operational] });
    if (route.kind !== 'ask') throw new Error(`expected ask, got ${route.kind}`);
    expect(route.questions.map((q) => q.requiresApprover)).toEqual([false, true, false]);
  });

  it('asking past maxQuestions batches for the Stage blocks instead', () => {
    const route = routeClarification({
      ...fresh,
      batchesUsed: 3,
      questions: [product],
    });
    expect(route.kind).toBe('blocked');
    if (route.kind !== 'blocked') return;
    expect(route.blocker.reason).toBe('clarification_cap_reached');
    expect(route.blocker.detail).toContain('3 of at most 3');
  });

  it('maxQuestions 0 never asks', () => {
    const route = routeClarification({ ...fresh, maxQuestions: 0, questions: [operational] });
    expect(route.kind).toBe('blocked');
  });
});

describe('the shape of a proposal’s questions', () => {
  it('a well-formed set has no issues', () => {
    expect(clarificationIssues([discoverable, technical, product, security, operational])).toEqual(
      [],
    );
  });

  it('a Technical question needs the agent’s decision', () => {
    const undecided: ClarificationQuestion = {
      category: 'technical',
      text: technical.text,
      options: ['bcrypt', 'argon2'],
    };
    expect(clarificationIssues([undecided]).map((i) => i.rule)).toEqual([
      'clarification.technical_decision',
    ]);
  });

  it('a human question needs at least two options and a recommended one of them', () => {
    const unrecommended: ClarificationQuestion = {
      category: 'security',
      text: security.text,
      options: ['allow', 'deny'],
    };
    const issues = clarificationIssues([
      { ...product, options: ['1h'] },
      unrecommended,
      { ...operational, recommended: 'something else' },
    ]);
    expect(issues.map((i) => i.rule)).toEqual([
      'clarification.options',
      'clarification.recommended',
      'clarification.recommended',
    ]);
  });

  it('triage and specification proposals carry optional questions', () => {
    const triage = TriageProposalSchema.parse({
      summary: 's',
      type: 'feature',
      risk: 'low',
      questions: [product],
    });
    expect(triage.questions).toHaveLength(1);
    expect(
      TriageProposalSchema.parse({ summary: 's', type: 'feature', risk: 'low' }).questions,
    ).toBeUndefined();
    expect(SpecificationProposalSchema.shape.questions).toBeDefined();
  });
});

describe('the Decision Records of Technical questions', () => {
  it('keeps each Technical decision, agent-proposed, and nothing else', () => {
    expect(decisionRecordsOf([product, technical, discoverable])).toEqual([
      {
        question: 'Which hashing library?',
        options: ['bcrypt', 'argon2'],
        decision: 'argon2',
        rationale: 'It is the current OWASP recommendation.',
        agentProposed: true,
      },
    ]);
  });
});
