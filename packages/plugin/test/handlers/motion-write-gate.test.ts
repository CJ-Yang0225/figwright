import { describe, expect, it, vi } from 'vitest';

import type { SandboxToolHandler } from '../../src/dispatcher.js';
import { createApplyAnimationStyleHandler } from '../../src/handlers/apply-animation-style.js';
import { createApplyManualKeyframeTrackHandler } from '../../src/handlers/apply-manual-keyframe-track.js';
import { createRemoveAnimationStyleHandler } from '../../src/handlers/remove-animation-style.js';
import { createRemoveManualKeyframeTrackHandler } from '../../src/handlers/remove-manual-keyframe-track.js';
import { createSetTimelineDurationHandler } from '../../src/handlers/set-timeline-duration.js';

// Motion reads are open to any editor with the API; writes must still be refused outside Figma
// Design before any mutation reaches Figma. Dev Mode is the editor that now reads, so it is the one
// that must prove the write gate held.

const FIELD = { type: 'PROPERTY', name: 'OPACITY' };

const WRITES: [string, (f: typeof figma) => SandboxToolHandler, Record<string, unknown>][] = [
  ['apply_animation_style', createApplyAnimationStyleHandler, { nodeId: '1:1', styleId: 'Fade' }],
  [
    'remove_animation_style (one)',
    createRemoveAnimationStyleHandler,
    {
      nodeId: '1:1',
      animationStyleId: 'A:1',
    },
  ],
  ['remove_animation_style (all)', createRemoveAnimationStyleHandler, { nodeId: '1:1' }],
  [
    'apply_manual_keyframe_track',
    createApplyManualKeyframeTrackHandler,
    {
      nodeId: '1:1',
      field: FIELD,
      track: { keyframes: [{ timelinePosition: 0, value: { type: 'FLOAT', value: 1 } }] },
    },
  ],
  [
    'remove_manual_keyframe_track',
    createRemoveManualKeyframeTrackHandler,
    {
      nodeId: '1:1',
      field: FIELD,
    },
  ],
  [
    'set_timeline_duration',
    createSetTimelineDurationHandler,
    {
      nodeId: '1:1',
      timelineId: 'T:1',
      duration: 2,
    },
  ],
];

describe('Motion writes in Dev Mode', () => {
  it.each(WRITES)('refuses %s before any Figma mutation', async (_, create, params) => {
    const node = {
      id: '1:1',
      animationStyles: [{ id: 'A:1', styleId: 'Fade' }],
      applyAnimationStyle: vi.fn<() => void>(),
      removeAnimationStyle: vi.fn<() => void>(),
      applyManualKeyframeTrack: vi.fn<() => void>(),
      removeManualKeyframeTrack: vi.fn<() => void>(),
      setTimelineDuration: vi.fn<() => void>(),
    };
    const getNodeByIdAsync = vi.fn<() => Promise<unknown>>(async () => node);
    const figmaCtx = {
      editorType: 'dev',
      motion: { playheadPosition: 0, figmaAnimationStyles: () => [] },
      getNodeByIdAsync,
    } as unknown as typeof figma;

    await expect(create(figmaCtx)(params)).rejects.toThrow(
      /only available in the Figma Design editor/,
    );

    for (const mutation of [
      node.applyAnimationStyle,
      node.removeAnimationStyle,
      node.applyManualKeyframeTrack,
      node.removeManualKeyframeTrack,
      node.setTimelineDuration,
    ]) {
      expect(mutation).not.toHaveBeenCalled();
    }
    expect(getNodeByIdAsync).not.toHaveBeenCalled();
  });
});
