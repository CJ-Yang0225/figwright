import type { GetNodeMotionResult } from '@figwright/shared';
import { describe, expect, it } from 'vitest';

import { createGetNodeMotionHandler } from '../../src/handlers/get-node-motion.js';

/** A node carrying the Motion mixin's state, as the Figma Design editor exposes it. */
const motionNode = (id: string): BaseNode =>
  ({ ...readOnlyMotionNode(id), applyAnimationStyle: () => {} }) as unknown as BaseNode;

/**
 * The same node as Dev Mode exposes it (measured): its Motion state reads, but the write methods
 * such as `applyAnimationStyle` are absent.
 */
function readOnlyMotionNode(id: string): BaseNode {
  return {
    id,
    animationStyles: [{ styleId: 'S:1', name: 'Fade in' }],
    animations: { OPACITY: { keyframes: [] } },
    manualKeyframeTracks: { TRANSLATION_X: { keyframes: [] } },
    timelines: [{ id: 'T:1', duration: 2, loopMode: 'LOOP' }],
  } as unknown as BaseNode;
}

/** A node with no Motion mixin at all (PAGE / DOCUMENT). */
const plainNode = (id: string): BaseNode => ({ id }) as unknown as BaseNode;

const fakeFigma = (opts: {
  editorType: string;
  playheadPosition?: number;
  node?: BaseNode | null;
}): typeof figma =>
  ({
    editorType: opts.editorType,
    motion: { playheadPosition: opts.playheadPosition },
    getNodeByIdAsync: async () => opts.node ?? null,
  }) as unknown as typeof figma;

describe('get_node_motion handler', () => {
  it("returns the node's Motion state alongside the editor playhead", async () => {
    const handler = createGetNodeMotionHandler(
      fakeFigma({ editorType: 'figma', playheadPosition: 1.25, node: motionNode('1:2') }),
    );
    const result = (await handler({ nodeId: '1:2' })) as GetNodeMotionResult;
    expect(result.nodeId).toBe('1:2');
    expect(result.playheadPosition).toBe(1.25);
    // A Timeline field a later API adds (none exists yet) is carried through, not mapped away.
    expect(result.motion?.timelines).toEqual([{ id: 'T:1', duration: 2, loopMode: 'LOOP' }]);
    expect(result.motion?.animationStyles).toEqual([{ styleId: 'S:1', name: 'Fade in' }]);
  });

  it('still reports the playhead when the node itself supports no Motion', async () => {
    const handler = createGetNodeMotionHandler(
      fakeFigma({ editorType: 'figma', playheadPosition: 0, node: plainNode('1:3') }),
    );
    const result = (await handler({ nodeId: '1:3' })) as GetNodeMotionResult;
    expect(result.motion).toBeNull();
    // 0 is a real playhead position — it must survive, not be dropped as falsy.
    expect(result.playheadPosition).toBe(0);
  });

  it('omits playheadPosition entirely when no timeline is active', async () => {
    const handler = createGetNodeMotionHandler(
      fakeFigma({ editorType: 'figma', node: motionNode('1:4') }),
    );
    const result = (await handler({ nodeId: '1:4' })) as GetNodeMotionResult;
    expect('playheadPosition' in result).toBe(false);
  });

  it('never touches figma.motion outside the Figma Design editor', async () => {
    const figmaCtx = {
      editorType: 'figjam',
      get motion(): never {
        throw new Error('figma.motion must not be read in FigJam');
      },
      getNodeByIdAsync: async () => motionNode('1:5'),
    } as unknown as typeof figma;
    const result = (await createGetNodeMotionHandler(figmaCtx)({
      nodeId: '1:5',
    })) as GetNodeMotionResult;
    expect('playheadPosition' in result).toBe(false);
    expect(result.motion).not.toBeNull();
  });

  it('keeps a timeline id and duration even when the API object does not enumerate them', async () => {
    class ApiTimeline {
      get id(): string {
        return 'T:9';
      }
      get duration(): number {
        return 4;
      }
    }
    const node = { ...(motionNode('1:6') as object), timelines: [new ApiTimeline()] };
    const result = (await createGetNodeMotionHandler(
      fakeFigma({ editorType: 'figma', node: node as unknown as BaseNode }),
    )({ nodeId: '1:6' })) as GetNodeMotionResult;
    expect(result.motion?.timelines).toEqual([{ id: 'T:9', duration: 4 }]);
  });

  it('returns motion: null for an unknown node id', async () => {
    const handler = createGetNodeMotionHandler({
      editorType: 'figma',
      motion: { playheadPosition: 3 },
      getNodeByIdAsync: async () => null,
    } as unknown as typeof figma);
    const result = (await handler({ nodeId: 'nope' })) as GetNodeMotionResult;
    expect(result).toEqual({ nodeId: 'nope', motion: null, playheadPosition: 3 });
  });

  it('throws when nodeId is the wrong type', async () => {
    const handler = createGetNodeMotionHandler(fakeFigma({ editorType: 'figma' }));
    await expect(handler({ nodeId: 5 })).rejects.toThrow(/nodeId/);
  });
});

describe('get_node_motion handler in Dev Mode', () => {
  /** What readOnlyMotionNode() reads back as. */
  const MOTION = {
    animationStyles: [{ styleId: 'S:1', name: 'Fade in' }],
    animations: { OPACITY: { keyframes: [] } },
    manualKeyframeTracks: { TRANSLATION_X: { keyframes: [] } },
    timelines: [{ id: 'T:1', duration: 2, loopMode: 'LOOP' }],
  };

  it.each([
    ['a zero playhead', 0],
    ['a positive playhead', 1.5],
  ])('reads %s alongside the full Motion state', async (_, playheadPosition) => {
    const handler = createGetNodeMotionHandler(
      fakeFigma({ editorType: 'dev', playheadPosition, node: readOnlyMotionNode('1:7') }),
    );
    const result = (await handler({ nodeId: '1:7' })) as GetNodeMotionResult;
    expect(result).toEqual({ nodeId: '1:7', motion: MOTION, playheadPosition });
  });

  it('omits playheadPosition when no timeline is active, keeping the Motion state', async () => {
    const handler = createGetNodeMotionHandler(
      fakeFigma({ editorType: 'dev', node: readOnlyMotionNode('1:8') }),
    );
    const result = (await handler({ nodeId: '1:8' })) as GetNodeMotionResult;
    expect(result).toEqual({ nodeId: '1:8', motion: MOTION });
  });

  it('omits playheadPosition when the editor exposes no Motion API', async () => {
    const figmaCtx = {
      editorType: 'dev',
      getNodeByIdAsync: async () => readOnlyMotionNode('1:9'),
    } as unknown as typeof figma;
    const result = (await createGetNodeMotionHandler(figmaCtx)({
      nodeId: '1:9',
    })) as GetNodeMotionResult;
    expect('playheadPosition' in result).toBe(false);
    expect(result.motion).not.toBeNull();
  });

  it("lets the playhead getter's own error through", async () => {
    const figmaCtx = {
      editorType: 'dev',
      motion: {
        get playheadPosition(): never {
          throw new Error('boom from playheadPosition');
        },
      },
      getNodeByIdAsync: async () => readOnlyMotionNode('1:10'),
    } as unknown as typeof figma;
    await expect(createGetNodeMotionHandler(figmaCtx)({ nodeId: '1:10' })).rejects.toThrow(
      'boom from playheadPosition',
    );
  });

  it.each([
    ['a page', plainNode('0:1')],
    ['the document', plainNode('0:0')],
    ['a deleted id', null],
  ])('still returns motion: null for %s', async (_, node) => {
    const handler = createGetNodeMotionHandler(
      fakeFigma({ editorType: 'dev', playheadPosition: 1, node }),
    );
    const result = (await handler({ nodeId: 'X:1' })) as GetNodeMotionResult;
    expect(result).toEqual({ nodeId: 'X:1', motion: null, playheadPosition: 1 });
  });
});
