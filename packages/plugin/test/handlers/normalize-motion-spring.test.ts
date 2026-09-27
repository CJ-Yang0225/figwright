import type { NormalizeMotionSpringResult } from '@figwright/shared';
import { describe, expect, it, vi } from 'vitest';

import { createNormalizeMotionSpringHandler } from '../../src/handlers/normalize-motion-spring.js';

const SPRING = { mass: 1, stiffness: 100, damping: 10 };

const fakeFigma = (editorType: string, motion?: unknown): typeof figma =>
  ({ editorType, motion }) as unknown as typeof figma;

describe('normalize_motion_spring handler', () => {
  it('converts in the Figma Design editor, sending only the three fields', async () => {
    const physicalSpringToNormalized = vi.fn<() => number>(() => 0.5);
    const handler = createNormalizeMotionSpringHandler(
      fakeFigma('figma', { physicalSpringToNormalized }),
    );
    const result = (await handler(SPRING)) as NormalizeMotionSpringResult;
    expect(result).toEqual({ bounce: 0.5 });
    expect(physicalSpringToNormalized).toHaveBeenCalledExactlyOnceWith(SPRING);
  });

  it('converts in Dev Mode when its API carries Motion', async () => {
    const physicalSpringToNormalized = vi.fn<() => number>(() => 0.5);
    const handler = createNormalizeMotionSpringHandler(
      fakeFigma('dev', { physicalSpringToNormalized }),
    );
    expect(await handler(SPRING)).toEqual({ bounce: 0.5 });
  });

  it('refuses in FigJam without reading figma.motion', async () => {
    const figmaCtx = {
      editorType: 'figjam',
      get motion(): never {
        throw new Error('figma.motion must not be read in FigJam');
      },
    } as unknown as typeof figma;
    await expect(createNormalizeMotionSpringHandler(figmaCtx)(SPRING)).rejects.toThrow(
      /normalize_motion_spring: the Figma Motion API is not available here/,
    );
  });

  it('refuses when the editor has no Motion API at all', async () => {
    await expect(createNormalizeMotionSpringHandler(fakeFigma('dev'))(SPRING)).rejects.toThrow(
      /Motion API is not available/,
    );
    await expect(createNormalizeMotionSpringHandler(fakeFigma('dev', {}))(SPRING)).rejects.toThrow(
      /Motion API is not available/,
    );
  });

  it("lets the API's own error through unchanged", async () => {
    const physicalSpringToNormalized = vi.fn<() => never>(() => {
      throw new Error('boom from physicalSpringToNormalized');
    });
    const handler = createNormalizeMotionSpringHandler(
      fakeFigma('dev', { physicalSpringToNormalized }),
    );
    await expect(handler(SPRING)).rejects.toThrow('boom from physicalSpringToNormalized');
    expect(physicalSpringToNormalized).toHaveBeenCalledOnce();
  });

  it.each([
    ['NaN', Number.NaN],
    ['below 0', -0.1],
    ['above 1', 1.5],
    ['not a number', 'nope'],
  ])('rejects a Figma answer that is %s, naming the value', async (_, bad) => {
    const handler = createNormalizeMotionSpringHandler(
      fakeFigma('figma', { physicalSpringToNormalized: () => bad }),
    );
    await expect(handler(SPRING)).rejects.toThrow(
      new RegExp(`bounce ${JSON.stringify(bad).replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
  });

  it.each([
    ['0', 0],
    ['1', 1],
  ])('accepts the %s endpoint', async (_, bounce) => {
    const handler = createNormalizeMotionSpringHandler(
      fakeFigma('figma', { physicalSpringToNormalized: () => bounce }),
    );
    expect(await handler(SPRING)).toEqual({ bounce });
  });

  it.each(['mass', 'stiffness', 'damping'] as const)(
    'throws when %s is the wrong type',
    async key => {
      const handler = createNormalizeMotionSpringHandler(fakeFigma('figma', {}));
      await expect(handler({ ...SPRING, [key]: 'nope' })).rejects.toThrow(new RegExp(key));
    },
  );
});
