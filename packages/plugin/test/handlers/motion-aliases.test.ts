import { describe, expect, it, vi } from 'vitest';

import { createApplyAnimationStyleHandler } from '../../src/handlers/apply-animation-style.js';
import { createApplyManualKeyframeTrackHandler } from '../../src/handlers/apply-manual-keyframe-track.js';
import { createBatchHandler } from '../../src/handlers/batch.js';

// Figma accepts a Motion variable binding of the wrong type (or to no variable at all), reads it back
// as the alias it was given, and plays something else — measured 2026-09-27. These are refused in
// the sandbox, the only side that can see a variable's type, before any Figma mutation.

const VARIABLES: Record<string, { id: string; name: string; resolvedType: string }> = {
  'V:ease': { id: 'V:ease', name: 'motion/ease', resolvedType: 'EASING' },
  'V:time': { id: 'V:time', name: 'motion/delay', resolvedType: 'TIMING' },
  'V:float': { id: 'V:float', name: 'size/gap', resolvedType: 'FLOAT' },
};
const alias = (id: string) => ({ type: 'VARIABLE_ALIAS', id });

const makeFigma = () => {
  const node = {
    id: '1:1',
    manualKeyframeTracks: {} as Record<string, unknown>,
    applyAnimationStyle: vi.fn<() => string>(() => '1:1:as:1'),
    removeAnimationStyle: vi.fn<() => void>(),
    applyManualKeyframeTrack: vi.fn<() => void>(),
    removeManualKeyframeTrack: vi.fn<() => void>(),
  };
  const figmaCtx = {
    editorType: 'figma',
    // batch snapshots every page's prototype flows before applying, so it reads root.children.
    root: { children: [] },
    getNodeByIdAsync: async (id: string) => (id === '1:1' ? node : null),
    variables: { getVariableByIdAsync: async (id: string) => VARIABLES[id] ?? null },
  } as unknown as typeof figma;
  const mutations = [
    node.applyAnimationStyle,
    node.removeAnimationStyle,
    node.applyManualKeyframeTrack,
    node.removeManualKeyframeTrack,
  ];
  return { figmaCtx, node, mutations };
};

const trackParams = (easing: unknown) => ({
  nodeId: '1:1',
  field: { type: 'PROPERTY', name: 'OPACITY' },
  track: {
    keyframes: [
      { timelinePosition: 0, value: { type: 'FLOAT', value: 0 } },
      { timelinePosition: 1, value: { type: 'FLOAT', value: 1 }, easing },
    ],
  },
});
const styleParams = (props: Record<string, unknown>) => ({
  nodeId: '1:1',
  styleId: 'Position',
  config: { props },
});

const REMEDY = /create_variable.*set_variable_value.*get_variable_defs/;

const BAD: [string, 'track' | 'style', Record<string, unknown>, RegExp][] = [
  ['keyframe easing → TIMING', 'track', trackParams(alias('V:time')), /TIMING.*EASING.*LINEAR/],
  ['keyframe easing → FLOAT', 'track', trackParams(alias('V:float')), /FLOAT.*EASING.*LINEAR/],
  ['keyframe easing → missing', 'track', trackParams(alias('V:gone')), /does not exist.*LINEAR/],
  ['props.easing → TIMING', 'style', styleParams({ easing: alias('V:time') }), /EASING.*LINEAR/],
  ['props.easing → FLOAT', 'style', styleParams({ easing: alias('V:float') }), /EASING.*LINEAR/],
  ['props.easing → missing', 'style', styleParams({ easing: alias('V:gone') }), /does not exist/],
  ['props.delay → FLOAT', 'style', styleParams({ delay: alias('V:float') }), /TIMING.*not apply/],
  ['props.delay → EASING', 'style', styleParams({ delay: alias('V:ease') }), /TIMING.*not apply/],
  ['props.delay → missing', 'style', styleParams({ delay: alias('V:gone') }), /does not exist/],
  [
    'props.duration → FLOAT',
    'style',
    styleParams({ duration: alias('V:float') }),
    /TIMING.*not apply/,
  ],
];

describe('Motion variable aliases', () => {
  it.each(BAD)(
    'refuses %s with the reason and the remedy, before any mutation',
    async (_, kind, params, reason) => {
      const { figmaCtx, mutations } = makeFigma();
      const handler =
        kind === 'track'
          ? createApplyManualKeyframeTrackHandler(figmaCtx)
          : createApplyAnimationStyleHandler(figmaCtx);

      const error = await Promise.resolve(handler(params)).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(reason);
      expect((error as Error).message).toMatch(REMEDY);
      for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
    },
  );

  it('refuses a missing variable in any other prop, which only has to exist', async () => {
    const { figmaCtx, mutations } = makeFigma();
    await expect(
      createApplyAnimationStyleHandler(figmaCtx)(styleParams({ distance: alias('V:gone') })),
    ).rejects.toThrow(/config\.props\.distance.*does not exist.*create_variable/);
    for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
  });

  it('hands well-typed aliases to Figma unchanged', async () => {
    const { figmaCtx, node } = makeFigma();
    const track = trackParams(alias('V:ease'));
    await createApplyManualKeyframeTrackHandler(figmaCtx)(track);
    expect(node.applyManualKeyframeTrack).toHaveBeenCalledWith(track.field, track.track);

    const style = styleParams({
      easing: alias('V:ease'),
      delay: alias('V:time'),
      duration: alias('V:time'),
      distance: alias('V:float'),
    });
    await createApplyAnimationStyleHandler(figmaCtx)(style);
    expect(node.applyAnimationStyle).toHaveBeenCalledWith('Position', style.config);
  });

  it('refuses a whole batch when one op carries a bad alias, leaving nothing changed', async () => {
    const { figmaCtx, mutations } = makeFigma();
    const handler = createBatchHandler(figmaCtx, {
      apply_animation_style: createApplyAnimationStyleHandler(figmaCtx),
      apply_manual_keyframe_track: createApplyManualKeyframeTrackHandler(figmaCtx),
    });

    await expect(
      handler({
        ops: [
          { tool: 'apply_manual_keyframe_track', params: trackParams(alias('V:ease')) },
          { tool: 'apply_animation_style', params: styleParams({ delay: alias('V:float') }) },
        ],
      }),
    ).rejects.toThrow(/batch\/apply_animation_style: config\.props\.delay.*TIMING/);
    for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();

    await expect(
      handler({
        ops: [
          { tool: 'apply_animation_style', params: styleParams({ easing: alias('V:ease') }) },
          { tool: 'apply_manual_keyframe_track', params: trackParams(alias('V:gone')) },
        ],
      }),
    ).rejects.toThrow(/batch\/apply_manual_keyframe_track: track\.keyframes\[1\]\.easing/);
    for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
  });

  it('applies a batch whose aliases are all well-typed', async () => {
    const { figmaCtx, node } = makeFigma();
    const handler = createBatchHandler(figmaCtx, {
      apply_animation_style: createApplyAnimationStyleHandler(figmaCtx),
      apply_manual_keyframe_track: createApplyManualKeyframeTrackHandler(figmaCtx),
    });
    const track = trackParams(alias('V:ease'));
    await handler({
      ops: [
        { tool: 'apply_manual_keyframe_track', params: track },
        { tool: 'apply_animation_style', params: styleParams({ delay: alias('V:time') }) },
      ],
    });
    expect(node.applyManualKeyframeTrack).toHaveBeenCalledWith(track.field, track.track);
    expect(node.applyAnimationStyle).toHaveBeenCalledWith('Position', {
      props: { delay: alias('V:time') },
    });
  });
});
