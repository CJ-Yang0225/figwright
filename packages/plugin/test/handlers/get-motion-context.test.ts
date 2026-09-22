import {
  DESIGN_CONTEXT_TOKEN_BUDGET,
  estimateResultTokens,
  type GetMotionContextResult,
} from '@figwright/shared';
import { describe, expect, it } from 'vitest';

import { createGetMotionContextHandler } from '../../src/handlers/get-motion-context.js';

interface FakeNode {
  id: string;
  name: string;
  type: string;
  parent: FakeNode | null;
  children?: FakeNode[];
  applyAnimationStyle?: () => void;
  animationStyles?: unknown[];
  animations?: Record<string, unknown>;
  manualKeyframeTracks?: Record<string, unknown>;
  timelines?: unknown[];
}

const binding = (times: number[]) => ({
  baseValue: { type: 'FLOAT', value: 0 },
  timelineDuration: 4,
  tracks: [
    {
      id: 'track',
      keyframeOperation: 'SET',
      keyframes: times.map((t, i) => ({
        id: `k${i}`,
        timelinePosition: t,
        value: { type: 'FLOAT', value: i },
        easing: { type: 'LINEAR' },
      })),
    },
  ],
});

/** A scene node with the Motion mixin; static unless given animations or styles. */
const node = (
  id: string,
  opts: {
    type?: string;
    children?: FakeNode[];
    animations?: Record<string, unknown>;
    animationStyles?: unknown[];
    timelines?: unknown[];
  } = {},
): FakeNode => {
  const n: FakeNode = {
    id,
    name: `name-${id}`,
    type: opts.type ?? (opts.children === undefined ? 'RECTANGLE' : 'FRAME'),
    parent: null,
    applyAnimationStyle: () => {},
    animationStyles: opts.animationStyles ?? [],
    animations: opts.animations ?? {},
    manualKeyframeTracks: {},
    timelines: opts.timelines ?? [{ id: 'T:1', duration: 4 }],
  };
  if (opts.children !== undefined) {
    n.children = opts.children;
    for (const c of opts.children) c.parent = n;
  }
  return n;
};

const animated = (id: string, times = [1, 1.25, 2]): FakeNode =>
  node(id, { animations: { OPACITY: binding(times) } });

const fakeFigma = (nodes: FakeNode[]): typeof figma => {
  const byId = new Map<string, FakeNode>();
  const index = (n: FakeNode): void => {
    byId.set(n.id, n);
    for (const c of n.children ?? []) index(c);
  };
  for (const n of nodes) index(n);
  return {
    editorType: 'figma',
    getNodeByIdAsync: async (id: string) => byId.get(id) ?? null,
  } as unknown as typeof figma;
};

const run = async (roots: FakeNode[], nodeId: string): Promise<GetMotionContextResult> =>
  (await createGetMotionContextHandler(fakeFigma(roots))({ nodeId })) as GetMotionContextResult;

const range = (n: number): number[] => [...Array(n).keys()];

const ids = (r: GetMotionContextResult): string[] => r.nodes.map(n => n.nodeId);

/** Follow pendingNodeIds until nothing is pending, the way the tool tells a caller to. */
const drain = async (roots: FakeNode[], nodeId: string): Promise<GetMotionContextResult[]> => {
  const results: GetMotionContextResult[] = [];
  const queue = [nodeId];
  while (queue.length > 0) {
    const r = await run(roots, queue.shift() as string);
    results.push(r);
    queue.push(...(r.coverage.pendingNodeIds ?? []));
  }
  return results;
};

describe('get_motion_context handler', () => {
  it('reports complete with no nodes for a static subtree', async () => {
    const root = node('1:1', { children: [node('1:2'), node('1:3', { children: [node('1:4')] })] });
    const r = await run([root], '1:1');
    expect(r).toEqual({
      rootNodeId: '1:1',
      coverage: { status: 'complete', visitedNodes: 4, animatedNodes: 0 },
      nodes: [],
    });
  });

  it('lists each instance of one component separately, under its own qualified id', async () => {
    // What get_design_context's dedupe drops: the second instance's child animates differently.
    const a = node('1:10', { type: 'INSTANCE', children: [animated('I1:10;2:1', [0, 1])] });
    const b = node('1:11', { type: 'INSTANCE', children: [animated('I1:11;2:1', [0.5, 3])] });
    const r = await run([node('1:1', { children: [a, b] })], '1:1');
    expect(ids(r)).toEqual(['I1:10;2:1', 'I1:11;2:1']);
    expect(r.nodes[1]).toMatchObject({
      parentId: '1:11',
      motion: { animations: { OPACITY: binding([0.5, 3]) } },
    });
  });

  it('finds a hidden, deep descendant under a static parent, in document order', async () => {
    const hidden = { ...animated('1:5'), visible: false };
    const root = node('1:1', {
      children: [node('1:2', { children: [node('1:3', { children: [hidden] })] }), animated('1:6')],
    });
    const r = await run([root], '1:1');
    expect(ids(r)).toEqual(['1:5', '1:6']);
    expect(r.coverage).toEqual({ status: 'complete', visitedNodes: 5, animatedNodes: 2 });
  });

  it('counts an applied style without keyframes, but not empty bindings', async () => {
    const styled = node('1:2', { animationStyles: [{ id: 'A:1', styleId: 'Opacity' }] });
    const empty = node('1:3', {
      animations: {
        fills: {},
        OPACITY: { baseValue: { type: 'FLOAT', value: 1 }, timelineDuration: 4, tracks: [] },
        TRANSLATION_X: { tracks: [{ id: 't', keyframeOperation: 'SET', keyframes: [] }] },
      },
    });
    const r = await run([node('1:1', { children: [styled, empty] })], '1:1');
    expect(ids(r)).toEqual(['1:2']);
  });

  it('passes raw Motion through untouched, future fields included', async () => {
    const future = {
      ...binding([0, 1]),
      loopMode: 'PING_PONG',
    };
    const n = node('1:2', {
      animations: { OPACITY: future, effects: { 0: { RADIUS: binding([0, 1]) } } },
      timelines: [{ id: 'T:1', duration: 4, trigger: 'ON_LOAD' }],
    });
    const r = await run([n], '1:2');
    expect(r.nodes[0]?.motion.animations).toEqual({
      OPACITY: future,
      effects: { 0: { RADIUS: binding([0, 1]) } },
    });
    expect(r.nodes[0]?.motion.timelines).toEqual([{ id: 'T:1', duration: 4, trigger: 'ON_LOAD' }]);
    expect(r.diagnostics).toBeUndefined();
  });

  it('flags an animated field the typings do not define, keeping its data', async () => {
    const n = node('1:2', {
      animations: {
        BLUR_AMOUNT: { baseValue: { type: 'FLOAT', value: 0 } },
        effects: { 1: { RADIUS: binding([0, 1]), GLOW: binding([0, 1]) } },
      },
    });
    const r = await run([n], '1:2');
    expect(r.coverage.status).toBe('complete');
    expect(r.nodes[0]?.motion.animations).toHaveProperty('BLUR_AMOUNT');
    expect(r.diagnostics).toEqual([
      {
        nodeId: '1:2',
        code: 'unknown-field',
        message: expect.stringMatching(/animations\.BLUR_AMOUNT, animations\.effects\.1\.GLOW/),
      },
    ]);
  });

  it('turns a descendant read failure into a diagnostic, not an absence', async () => {
    const broken = node('1:3');
    Object.defineProperty(broken, 'animations', {
      get() {
        throw new Error('getter exploded');
      },
    });
    const r = await run([node('1:1', { children: [broken, animated('1:4')] })], '1:1');
    expect(ids(r)).toEqual(['1:4']);
    expect(r.coverage).toMatchObject({ status: 'partial', reasons: ['read-error'] });
    expect(r.diagnostics).toEqual([
      { nodeId: '1:3', code: 'read-error', message: 'getter exploded' },
    ]);
  });

  it('fails the call when the root itself cannot be read', async () => {
    const root = node('1:1');
    Object.defineProperty(root, 'animationStyles', {
      get() {
        throw new Error('Motion unavailable');
      },
    });
    await expect(run([root], '1:1')).rejects.toThrow('Motion unavailable');
  });

  it('rejects an unknown id and a node without Motion', async () => {
    await expect(run([], '9:9')).rejects.toThrow(/not found/);
    const page = { id: '0:1', name: 'Page', type: 'PAGE', parent: null } as FakeNode;
    await expect(run([page], '0:1')).rejects.toThrow(/PAGE, which carries no Figma Motion/);
  });

  it('stops at the node limit with disjoint pending roots that together cover the rest', async () => {
    // 40 sections × 50 layers = 2,041 nodes, over the 1,500 visit cap; one animated layer each.
    const sections = range(40).map(s =>
      node(`2:${s}`, {
        children: range(50).map(l => (l === 25 ? animated(`3:${s}-${l}`) : node(`3:${s}-${l}`))),
      }),
    );
    const root = node('1:1', { children: sections });

    const first = await run([root], '1:1');
    expect(first.coverage).toMatchObject({
      status: 'partial',
      visitedNodes: 1500,
      reasons: ['node-limit'],
    });

    const all = (await drain([root], '1:1')).flatMap(ids);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(40);
  });

  it('lists every pending root of a wide tree while the output has room for them', async () => {
    // 3,000 direct children: half are left unread, and each must stay reachable by id.
    const root = node('1:1', {
      children: range(3000).map(i => (i % 500 === 499 ? animated(`6:${i}`) : node(`6:${i}`))),
    });
    const first = await run([root], '1:1');
    expect(first.coverage.pendingNodeIds).toHaveLength(1501);
    expect(first.coverage.pendingOmitted).toBeUndefined();

    const all = (await drain([root], '1:1')).flatMap(ids);
    expect(all).toEqual(['6:499', '6:999', '6:1499', '6:1999', '6:2499', '6:2999']);
  });

  it('hands back the node that no longer fits, and reads it on its own call', async () => {
    // Each node ~2k estimated tokens, so a call holds several but not all of them.
    const heavy = (id: string): FakeNode =>
      animated(
        id,
        range(30).map(i => i / 10),
      );
    const root = node('1:1', {
      children: range(30).map(i => heavy(`4:${i}`)),
    });

    const first = await run([root], '1:1');
    expect(first.coverage).toMatchObject({ status: 'partial', reasons: ['payload-limit'] });
    const next = first.coverage.pendingNodeIds?.[0];
    expect(next).toBe(`4:${first.nodes.length}`);

    const all = (await drain([root], '1:1')).flatMap(ids);
    expect(all).toEqual(range(30).map(i => `4:${i}`));
  });

  it('reports a node too large for any call instead of pending it forever', async () => {
    const giant = animated(
      '5:1',
      range(2000).map(i => i / 100),
    );
    giant.children = [animated('5:2')];
    (giant.children[0] as FakeNode).parent = giant;
    const r = await run([giant], '5:1');
    expect(ids(r)).toEqual(['5:2']);
    expect(r.coverage).toMatchObject({ status: 'partial', reasons: ['payload-limit'] });
    expect(r.coverage.pendingNodeIds).toBeUndefined();
    expect(r.diagnostics?.[0]).toMatchObject({ nodeId: '5:1', code: 'node-over-budget' });
  });

  it('stays inside the client budget with every cap saturated', async () => {
    // Long ids, a full node budget, and more failing layers and pending roots than the caps allow.
    const longId = (p: string, i: number): string => `I${p}${'9'.repeat(20)}:${i};123456:${i}`;
    const failing = range(40).map(i => {
      const n = node(longId('7', i));
      Object.defineProperty(n, 'animations', {
        get() {
          throw new Error('x'.repeat(2000));
        },
      });
      return n;
    });
    const heavy = range(30).map(i =>
      animated(
        longId('8', i),
        range(30).map(k => k / 10),
      ),
    );
    const tail = range(2000).map(i => node(longId('6', i)));
    const root = node('1:1', { children: [...failing, ...heavy, ...tail] });

    const r = await run([root], '1:1');
    expect(r.coverage.reasons).toEqual(['read-error', 'payload-limit']);
    expect(r.diagnosticsOmitted).toBe(20);
    expect(r.coverage.pendingOmitted).toBeGreaterThan(0);
    expect(estimateResultTokens(JSON.stringify(r))).toBeLessThanOrEqual(
      DESIGN_CONTEXT_TOKEN_BUDGET,
    );
  });

  describe('with skipInvisibleInstanceChildren on (the Dev Mode default)', () => {
    // The flag as the typings document it: an instance's `children` omits its hidden layers, and a
    // hidden layer's node object throws on any read, while the flag is on.
    const devMode = (
      roots: FakeNode[],
    ): typeof figma & { skipInvisibleInstanceChildren: boolean } =>
      Object.assign(fakeFigma(roots), { skipInvisibleInstanceChildren: true });
    const hiddenIn = (
      ctx: { skipInvisibleInstanceChildren: boolean },
      instance: FakeNode,
      child: FakeNode,
    ): void => {
      child.parent = instance;
      const guarded = new Proxy(child, {
        get(target, key, receiver) {
          if (ctx.skipInvisibleInstanceChildren)
            throw new Error(`node ${child.id} is not accessible`);
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
      Object.defineProperty(instance, 'children', {
        get: () => (ctx.skipInvisibleInstanceChildren ? [] : [guarded]),
      });
    };

    it('still finds a hidden animated layer inside an instance, and restores the flag', async () => {
      const instance = node('1:2', { type: 'INSTANCE' });
      const root = node('1:1', { children: [instance] });
      const ctx = devMode([root]);
      hiddenIn(ctx, instance, { ...animated('I1:2;3:1'), visible: false } as FakeNode);

      const r = (await createGetMotionContextHandler(ctx)({
        nodeId: '1:1',
      })) as GetMotionContextResult;
      expect(ids(r)).toEqual(['I1:2;3:1']);
      expect(r.nodes[0]?.parentId).toBe('1:2');
      expect(r.coverage).toEqual({ status: 'complete', visitedNodes: 3, animatedNodes: 1 });
      expect(ctx.skipInvisibleInstanceChildren).toBe(true);
    });

    it('lists a hidden instance layer as pending before the flag goes back on', async () => {
      // Two ~11k-token nodes: the first fits, the hidden one is handed back — its id must be read
      // while it is still accessible.
      const big = (id: string): FakeNode =>
        animated(
          id,
          range(250).map(i => i / 100),
        );
      const instance = node('1:3', { type: 'INSTANCE' });
      const root = node('1:1', { children: [big('1:2'), instance] });
      const ctx = devMode([root]);
      hiddenIn(ctx, instance, { ...big('I1:3;3:1'), visible: false } as FakeNode);

      const r = (await createGetMotionContextHandler(ctx)({
        nodeId: '1:1',
      })) as GetMotionContextResult;
      expect(ids(r)).toEqual(['1:2']);
      expect(r.coverage).toMatchObject({
        reasons: ['payload-limit'],
        pendingNodeIds: ['I1:3;3:1'],
      });
      expect(ctx.skipInvisibleInstanceChildren).toBe(true);
    });

    it('restores the flag when the root read fails, and says why a lookup can miss', async () => {
      const root = node('1:1');
      Object.defineProperty(root, 'animationStyles', {
        get() {
          throw new Error('Motion unavailable');
        },
      });
      const ctx = devMode([root]);
      await expect(createGetMotionContextHandler(ctx)({ nodeId: '1:1' })).rejects.toThrow(
        'Motion unavailable',
      );
      expect(ctx.skipInvisibleInstanceChildren).toBe(true);
      await expect(createGetMotionContextHandler(ctx)({ nodeId: 'I1:2;3:1' })).rejects.toThrow(
        /hides invisible layers inside instances/,
      );
      await expect(run([], 'I1:2;3:1')).rejects.toThrow(/works too\)\.$/);
    });
  });

  describe('edge cases', () => {
    it('walks through a layer without the Motion mixin to the animated child below it', async () => {
      const bare: FakeNode = { id: '1:2', name: 'bare', type: 'SLICE', parent: null };
      bare.children = [animated('1:3')];
      (bare.children[0] as FakeNode).parent = bare;
      const r = await run([node('1:1', { children: [bare] })], '1:1');
      expect(ids(r)).toEqual(['1:3']);
      expect(r.coverage).toEqual({ status: 'complete', visitedNodes: 3, animatedNodes: 1 });
    });

    it('counts keyframes that exist only in the manual tracks', async () => {
      const n = node('1:2');
      n.manualKeyframeTracks = { OPACITY: { id: 't', baseValue: 1, keyframes: [{ id: 'k' }] } };
      expect(ids(await run([n], '1:2'))).toEqual(['1:2']);
    });

    it('finds keyframes on component-property-bound paints and effects, flagging nothing', async () => {
      const n = node('1:2', {
        animations: {
          fills: { 0: { properties: { 'prop:1': binding([0, 1]) } } },
          effects: { 2: { properties: { 'prop:2': binding([0, 1]) } } },
        },
      });
      const r = await run([n], '1:2');
      expect(ids(r)).toEqual(['1:2']);
      expect(r.diagnostics).toBeUndefined();
    });

    it('flags an unknown field in the manual tracks, and lists a node carrying only that', async () => {
      const n = node('1:2');
      n.manualKeyframeTracks = { GLOW_SIZE: { id: 't', keyframes: [] } };
      const r = await run([n], '1:2');
      expect(ids(r)).toEqual(['1:2']);
      expect(r.diagnostics?.[0]?.message).toMatch(/manualKeyframeTracks\.GLOW_SIZE/);
    });

    it('caps a long error message and survives a non-Error throw', async () => {
      const long = node('1:2');
      Object.defineProperty(long, 'animations', {
        get() {
          throw new Error('y'.repeat(5000));
        },
      });
      const odd = node('1:3');
      Object.defineProperty(odd, 'animations', {
        get() {
          // eslint-disable-next-line no-throw-literal -- the plugin API is not ours; it may throw anything
          throw 'plain string';
        },
      });
      const r = await run([node('1:1', { children: [long, odd] })], '1:1');
      expect(r.diagnostics?.map(d => d.message.length)).toEqual([300, 'plain string'.length]);
    });

    it('treats exactly the visit cap as complete and one more as partial', async () => {
      const tree = (n: number): FakeNode =>
        node('1:1', { children: range(n - 1).map(i => node(`7:${i}`)) });
      expect((await run([tree(1500)], '1:1')).coverage).toEqual({
        status: 'complete',
        visitedNodes: 1500,
        animatedNodes: 0,
      });
      expect((await run([tree(1501)], '1:1')).coverage).toMatchObject({
        status: 'partial',
        visitedNodes: 1500,
        pendingNodeIds: ['7:1499'],
      });
    });

    it('keeps exactly the diagnostic cap and counts the rest', async () => {
      const failing = (n: number): FakeNode =>
        node('1:1', {
          children: range(n).map(i => {
            const f = node(`8:${i}`);
            Object.defineProperty(f, 'animations', {
              get() {
                throw new Error('boom');
              },
            });
            return f;
          }),
        });
      const at = await run([failing(20)], '1:1');
      expect(at.diagnostics).toHaveLength(20);
      expect(at.diagnosticsOmitted).toBeUndefined();
      const over = await run([failing(21)], '1:1');
      expect(over.diagnostics).toHaveLength(20);
      expect(over.diagnosticsOmitted).toBe(1);
    });

    it('walks a chain deeper than any call stack would allow recursion for', async () => {
      let leaf = animated('9:1399');
      for (let i = 1398; i >= 0; i -= 1) leaf = node(`9:${i}`, { children: [leaf] });
      const r = await run([leaf], '9:0');
      expect(ids(r)).toEqual(['9:1399']);
      expect(r.coverage.status).toBe('complete');
    });

    it('stays inside the client budget when names and errors are CJK', async () => {
      // A CJK character estimates at a full token, twice an ASCII one: the tightest case.
      const cjk = '動畫'.repeat(150);
      const heavy = range(30).map(i => {
        const n = animated(
          `4:${i}`,
          range(30).map(k => k / 10),
        );
        n.name = cjk;
        return n;
      });
      const failing = range(30).map(i => {
        const f = node(`8:${i}`);
        Object.defineProperty(f, 'animations', {
          get() {
            throw new Error(cjk);
          },
        });
        return f;
      });
      const tail = range(1000).map(i => node(`6:${i}`));
      const r = await run([node('1:1', { children: [...failing, ...heavy, ...tail] })], '1:1');
      expect(r.coverage.status).toBe('partial');
      // Fewer CJK diagnostics fit, and the rest are still counted rather than dropped.
      expect((r.diagnostics?.length ?? 0) + (r.diagnosticsOmitted ?? 0)).toBe(30);
      expect(estimateResultTokens(JSON.stringify(r))).toBeLessThanOrEqual(
        DESIGN_CONTEXT_TOKEN_BUDGET,
      );
    });

    it('rejects a nodeId that is not a string', async () => {
      await expect(createGetMotionContextHandler(fakeFigma([]))({ nodeId: 7 })).rejects.toThrow(
        /nodeId must be a string/,
      );
    });
  });
});
