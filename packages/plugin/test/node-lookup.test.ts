import type { GetNodeMotionResult, MutateResult } from '@figwright/shared';
import { describe, expect, it } from 'vitest';

import { createSandboxHandlers } from '../src/handlers/registry.js';
import { withInstanceIdLookup } from '../src/node-lookup.js';

// Figma's own rejection, measured live in the R7 state: a bare string, not an Error.
const R7 =
  'Unable to establish connection to Figma after 10 seconds. Please check your internet connection.';

interface FakeNode {
  id: string;
  name: string;
  visible: boolean;
  children?: FakeNode[];
  applyAnimationStyle: () => void;
  animationStyles: unknown[];
  animations: Record<string, unknown>;
  manualKeyframeTracks: Record<string, unknown>;
  timelines: { id: string; duration: number }[];
  findOne?: (cb: (n: FakeNode) => boolean) => FakeNode | null;
}

const node = (id: string, children?: FakeNode[], visible = true): FakeNode => {
  const n: FakeNode = {
    id,
    name: id,
    visible,
    applyAnimationStyle: () => {},
    animationStyles: [],
    // The id as a keyframe value, so a read proves which node it resolved to.
    animations: { OPACITY: { keyframes: [{ time: 0, value: id }] } },
    manualKeyframeTracks: {},
    timelines: [],
  };
  if (children !== undefined) {
    n.children = children;
    n.findOne = cb => {
      for (const child of children) {
        if (cb(child)) return child;
        const deeper = child.findOne?.(cb) ?? null;
        if (deeper !== null) return deeper;
      }
      return null;
    };
  }
  return n;
};

/**
 * The R7 state as a test double: the by-id lookup rejects every instance-qualified id with Figma's
 * bare string, and — unless `unknown: 'null'` — every id it does not know as well (`999:999` timed
 * out live too). Plain ids it knows resolve. Every call is recorded.
 */
const r7Figma = (opts: { unknown: 'reject' | 'null' } = { unknown: 'reject' }) => {
  const hidden = node('I2:6;2:7', undefined, false);
  const nestedChild = node('I2:6;3:1;3:2');
  const sublayer = node('I2:6;2:5');
  const instance = node('2:6', [sublayer, hidden, node('I2:6;3:1', [nestedChild])]);
  const frame = node('1:3', [instance]);
  const plain = new Map<string, FakeNode>([
    ['1:3', frame],
    ['2:6', instance],
  ]);
  const lookups: string[] = [];
  const figmaCtx = {
    editorType: 'figma',
    motion: {},
    skipInvisibleInstanceChildren: false,
    getNodeByIdAsync: async (id: string) => {
      lookups.push(id);
      if (id.startsWith('I')) throw R7; // eslint-disable-line no-throw-literal
      const found = plain.get(id);
      if (found !== undefined) return found;
      if (opts.unknown === 'reject') throw R7; // eslint-disable-line no-throw-literal
      return null;
    },
  } as unknown as typeof figma;
  return { figmaCtx, lookups, instance, sublayer, hidden, nestedChild };
};

describe('instance-qualified ids resolve from the instance root, never through Figma by id', () => {
  it.each([
    ['two-level', 'I2:6;2:5'],
    ['three-level (nested instance)', 'I2:6;3:1;3:2'],
    ['hidden sublayer', 'I2:6;2:7'],
  ])('get_node_motion reads a %s sublayer', async (_, id) => {
    const { figmaCtx, lookups } = r7Figma();
    const result = (await createSandboxHandlers(figmaCtx).get_node_motion!({
      nodeId: id,
    })) as GetNodeMotionResult;
    expect(result.nodeId).toBe(id);
    expect(result.motion?.animations).toEqual({ OPACITY: { keyframes: [{ time: 0, value: id }] } });
    expect(lookups).toEqual(['2:6']);
  });

  it('a write handler (rename_node) changes the same node', async () => {
    const { figmaCtx, lookups, nestedChild, sublayer } = r7Figma();
    const result = (await createSandboxHandlers(figmaCtx).rename_node!({
      nodeId: 'I2:6;3:1;3:2',
      name: 'renamed',
      requestId: 'r1',
    })) as MutateResult;
    expect(result).toEqual({ ok: true, nodeId: 'I2:6;3:1;3:2' });
    expect(nestedChild.name).toBe('renamed');
    expect(sublayer.name).toBe('I2:6;2:5');
    expect(lookups.some(id => id.startsWith('I'))).toBe(false);
  });

  it('a sublayer missing from an existing instance takes each handler’s miss path', async () => {
    const { figmaCtx, lookups } = r7Figma();
    const handlers = createSandboxHandlers(figmaCtx);
    const miss = (await handlers.get_node_motion!({ nodeId: 'I2:6;9:9' })) as GetNodeMotionResult;
    expect(miss).toEqual({ nodeId: 'I2:6;9:9', motion: null });
    await expect(handlers.rename_node!({ nodeId: 'I2:6;9:9', name: 'x' })).rejects.toThrow(
      'rename_node: node I2:6;9:9 not found',
    );
    expect(lookups.some(id => id.startsWith('I'))).toBe(false);
  });

  it('a missing instance root is a miss when Figma answers null for that plain id', async () => {
    const { figmaCtx, lookups } = r7Figma({ unknown: 'null' });
    const miss = (await createSandboxHandlers(figmaCtx).get_node_motion!({
      nodeId: 'I7:7;2:5',
    })) as GetNodeMotionResult;
    expect(miss).toEqual({ nodeId: 'I7:7;2:5', motion: null });
    expect(lookups).toEqual(['7:7']);
  });

  it('a missing instance root fails exactly as a plain unknown id does when Figma rejects it', async () => {
    const { figmaCtx, lookups } = r7Figma();
    const handlers = createSandboxHandlers(figmaCtx);
    await expect(handlers.get_node_motion!({ nodeId: 'I7:7;2:5' })).rejects.toBe(R7);
    await expect(handlers.get_node_motion!({ nodeId: '7:7' })).rejects.toBe(R7);
    expect(lookups).toEqual(['7:7', '7:7']);
  });

  it('a plain id goes to Figma unchanged', async () => {
    const { figmaCtx, lookups, instance } = r7Figma({ unknown: 'null' });
    const ctx = withInstanceIdLookup(figmaCtx);
    expect(await ctx.getNodeByIdAsync('2:6')).toBe(instance);
    expect(await ctx.getNodeByIdAsync('999:999')).toBeNull();
    expect(lookups).toEqual(['2:6', '999:999']);
  });
});

describe('withInstanceIdLookup forwards everything else to the real API object', () => {
  it('runs getters, setters and methods on the wrapped object', async () => {
    class Api {
      skip = false;
      calls: unknown[] = [];
      get skipInvisibleInstanceChildren(): boolean {
        return this.skip;
      }
      set skipInvisibleInstanceChildren(value: boolean) {
        this.skip = value;
      }
      notify(message: string): void {
        this.calls.push([this, message]);
      }
    }
    const api = new Api();
    const ctx = withInstanceIdLookup(api as unknown as typeof figma);
    ctx.skipInvisibleInstanceChildren = true;
    expect(api.skip).toBe(true);
    expect(ctx.skipInvisibleInstanceChildren).toBe(true);
    ctx.notify('hi');
    expect(api.calls).toEqual([[api, 'hi']]);
    expect('notify' in ctx).toBe(true);
  });
});
