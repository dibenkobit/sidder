import { describe, expect, test } from 'bun:test';
import { DependencyCycleError, UnknownDependencyError } from '../../src/errors.ts';
import { orderSeeds } from '../../src/plan/order.ts';
import type { ResolvedSeed } from '../../src/types.ts';

function seed(name: string, dependsOn?: string[]): ResolvedSeed {
  return {
    name,
    file: `${name}.ts`,
    run: async () => {},
    ...(dependsOn ? { dependsOn } : {}),
  };
}

const names = (seeds: ResolvedSeed[]) => seeds.map((s) => s.name);

describe('orderSeeds', () => {
  test('puts a seed after everything it depends on', () => {
    const ordered = orderSeeds([
      seed('demo', ['territory', 'roles']),
      seed('territory'),
      seed('roles'),
    ]);

    expect(names(ordered)).toEqual(['territory', 'roles', 'demo']);
  });

  test('keeps input order among seeds that do not depend on each other', () => {
    expect(names(orderSeeds([seed('c'), seed('a'), seed('b')]))).toEqual(['c', 'a', 'b']);
  });

  test('resolves a chain of dependencies', () => {
    const ordered = orderSeeds([seed('d', ['c']), seed('c', ['b']), seed('b', ['a']), seed('a')]);

    expect(names(ordered)).toEqual(['a', 'b', 'c', 'd']);
  });

  test('is stable across shuffles of independent seeds', () => {
    const first = names(orderSeeds([seed('x'), seed('y'), seed('z', ['x'])]));
    const again = names(orderSeeds([seed('x'), seed('y'), seed('z', ['x'])]));

    expect(first).toEqual(again);
  });

  test('names the unknown dependency and lists what does exist', () => {
    expect(() => orderSeeds([seed('demo', ['terrytory']), seed('territory')])).toThrow(
      UnknownDependencyError,
    );

    try {
      orderSeeds([seed('demo', ['terrytory']), seed('territory')]);
    } catch (error) {
      expect((error as UnknownDependencyError).message).toContain('terrytory');
      expect((error as UnknownDependencyError).hint).toContain('territory');
    }
  });

  test('reports the actual path of a cycle, not just that there is one', () => {
    try {
      orderSeeds([seed('a', ['c']), seed('b', ['a']), seed('c', ['b'])]);
      throw new Error('expected a cycle');
    } catch (error) {
      expect(error).toBeInstanceOf(DependencyCycleError);
      const { message } = error as DependencyCycleError;
      expect(message).toContain('→');
      // Every seed in this cycle should be named in the message.
      for (const name of ['a', 'b', 'c']) expect(message).toContain(name);
    }
  });

  test('reports a seed that depends on itself', () => {
    expect(() => orderSeeds([seed('a', ['a'])])).toThrow(DependencyCycleError);
  });

  test('accepts an empty list', () => {
    expect(orderSeeds([])).toEqual([]);
  });
});
