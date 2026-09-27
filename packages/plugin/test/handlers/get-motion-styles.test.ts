import type { GetMotionStylesResult } from '@figwright/shared';
import { describe, expect, it, vi } from 'vitest';

import { createGetMotionStylesHandler } from '../../src/handlers/get-motion-styles.js';

const PRESETS = [
  { styleId: 'Position', name: 'Position', description: 'Slide', props: { direction: 'LEFT' } },
  { styleId: 'Fade', name: 'Fade' },
];

const fakeFigma = (editorType: string, motion?: unknown): typeof figma =>
  ({ editorType, motion }) as unknown as typeof figma;

describe('get_motion_styles handler', () => {
  it('lists the presets in the Figma Design editor', async () => {
    const handler = createGetMotionStylesHandler(
      fakeFigma('figma', { figmaAnimationStyles: () => PRESETS }),
    );
    const result = (await handler({})) as GetMotionStylesResult;
    expect(result).toEqual({ styles: PRESETS });
  });

  it('lists the presets in Dev Mode when its API carries Motion', async () => {
    const handler = createGetMotionStylesHandler(
      fakeFigma('dev', { figmaAnimationStyles: () => PRESETS }),
    );
    const result = (await handler({})) as GetMotionStylesResult;
    expect(result).toEqual({ styles: PRESETS });
  });

  it('refuses in FigJam without reading figma.motion', async () => {
    const figmaCtx = {
      editorType: 'figjam',
      get motion(): never {
        throw new Error('figma.motion must not be read in FigJam');
      },
    } as unknown as typeof figma;
    await expect(createGetMotionStylesHandler(figmaCtx)({})).rejects.toThrow(
      /get_motion_styles: the Figma Motion API is not available here/,
    );
  });

  it('refuses when the editor has no Motion API at all', async () => {
    await expect(createGetMotionStylesHandler(fakeFigma('dev'))({})).rejects.toThrow(
      /Motion API is not available/,
    );
    await expect(createGetMotionStylesHandler(fakeFigma('dev', {}))({})).rejects.toThrow(
      /Motion API is not available/,
    );
  });

  it('returns an empty list as a successful query', async () => {
    const handler = createGetMotionStylesHandler(
      fakeFigma('dev', { figmaAnimationStyles: () => [] }),
    );
    expect(await handler({})).toEqual({ styles: [] });
  });

  it("lets the API's own error through unchanged", async () => {
    const figmaAnimationStyles = vi.fn<() => never>(() => {
      throw new Error('boom from figmaAnimationStyles');
    });
    const handler = createGetMotionStylesHandler(fakeFigma('dev', { figmaAnimationStyles }));
    await expect(handler({})).rejects.toThrow('boom from figmaAnimationStyles');
    expect(figmaAnimationStyles).toHaveBeenCalledOnce();
  });
});
