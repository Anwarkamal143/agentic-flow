/**
 * The Delivery Order (ADR-0052, GLOSSARY): the order a multi-Repository Job's
 * pull requests may merge, taken from the Plan's cross-repo dependency edges.
 * A cycle between Repositories makes the Plan invalid. Pure; tested through
 * `@factory/domain`.
 */
import { deliveryOrder } from '@factory/domain';
import { describe, expect, it } from 'vitest';

const API = { id: 'repo_api', name: 'api' };
const WEB = { id: 'repo_web', name: 'web' };
const ADMIN = { id: 'repo_admin', name: 'admin' };

const task = (key: string, repository: string, dependsOn: string[] = []) => ({
  key,
  repository,
  dependsOn,
});

describe('deliveryOrder', () => {
  it('puts the upstream Repository first, with the edge that orders it', () => {
    expect(
      deliveryOrder(
        [task('web-use', 'repo_web', ['api-expand']), task('api-expand', 'repo_api')],
        [WEB, API],
      ),
    ).toEqual({
      ok: true,
      order: [
        { repositoryId: 'repo_api', name: 'api', after: [] },
        { repositoryId: 'repo_web', name: 'web', after: ['repo_api'] },
      ],
    });
  });

  it('gives a single-Repository Plan one entry, whatever its own dependencies', () => {
    expect(deliveryOrder([task('a', 'repo_api'), task('b', 'repo_api', ['a'])], [API])).toEqual({
      ok: true,
      order: [{ repositoryId: 'repo_api', name: 'api', after: [] }],
    });
  });

  it('breaks ties between unordered Repositories by name, and leaves out one with no Task', () => {
    expect(
      deliveryOrder([task('w', 'repo_web'), task('a', 'repo_api')], [WEB, API, ADMIN]),
    ).toEqual({
      ok: true,
      order: [
        { repositoryId: 'repo_api', name: 'api', after: [] },
        { repositoryId: 'repo_web', name: 'web', after: [] },
      ],
    });
  });

  it('orders a chain transitively and lists only the direct upstreams', () => {
    // admin → api → web, and web also uses admin directly.
    const result = deliveryOrder(
      [
        task('web', 'repo_web', ['api', 'admin']),
        task('api', 'repo_api', ['admin']),
        task('admin', 'repo_admin'),
      ],
      [API, WEB, ADMIN],
    );
    expect(result).toEqual({
      ok: true,
      order: [
        { repositoryId: 'repo_admin', name: 'admin', after: [] },
        { repositoryId: 'repo_api', name: 'api', after: ['repo_admin'] },
        { repositoryId: 'repo_web', name: 'web', after: ['repo_admin', 'repo_api'] },
      ],
    });
  });

  it('finds a cycle between Repositories even when the Task graph has none', () => {
    // api.a → web.b → api.c: no Task cycle, but api must merge both before and after web.
    expect(
      deliveryOrder(
        [task('a', 'repo_api'), task('b', 'repo_web', ['a']), task('c', 'repo_api', ['b'])],
        [API, WEB],
      ),
    ).toEqual({ ok: false, cycle: ['api', 'web', 'api'] });
  });

  it('ignores dependencies on unknown Tasks (plan.dependencies_exist reports them)', () => {
    expect(deliveryOrder([task('a', 'repo_api', ['ghost'])], [API])).toEqual({
      ok: true,
      order: [{ repositoryId: 'repo_api', name: 'api', after: [] }],
    });
  });
});
