import { ErrorCode } from '@figwright/shared';
import { describe, expect, it } from 'vitest';

import { applyAnimationStyleTool } from '../../src/tools/apply-animation-style.js';
import { applyManualKeyframeTrackTool } from '../../src/tools/apply-manual-keyframe-track.js';
import { createVariableTool } from '../../src/tools/create-variable.js';
import {
  animationStyleConfigSchema,
  keyframeFieldSchema,
  keyframeValueSchema,
  manualKeyframeTrackInputSchema,
  MOTION_EASING_TYPES,
  motionEasingSchema,
} from '../../src/tools/motion-schemas.js';
import { setVariableValueTool } from '../../src/tools/set-variable-value.js';
import { checkBatchOps, checkWireCall } from '../../src/tools/wire-schema.js';

describe('motionEasingSchema', () => {
  it('accepts a named preset with no extra params', () => {
    expect(motionEasingSchema.safeParse({ type: 'EASE_OUT' }).success).toBe(true);
  });

  it('accepts CUSTOM_CUBIC_BEZIER with control points and CUSTOM_SPRING with bounce', () => {
    expect(
      motionEasingSchema.safeParse({
        type: 'CUSTOM_CUBIC_BEZIER',
        easingFunctionCubicBezier: { x1: 0.4, y1: 0, x2: 0.2, y2: 1 },
      }).success,
    ).toBe(true);
    expect(
      motionEasingSchema.safeParse({ type: 'CUSTOM_SPRING', easingFunctionSpring: { bounce: 0.5 } })
        .success,
    ).toBe(true);
  });

  it('rejects an unknown easing type and an out-of-range spring bounce', () => {
    expect(motionEasingSchema.safeParse({ type: 'WOBBLE' }).success).toBe(false);
    expect(
      motionEasingSchema.safeParse({ type: 'CUSTOM_SPRING', easingFunctionSpring: { bounce: 2 } })
        .success,
    ).toBe(false);
  });
});

describe('keyframeValueSchema', () => {
  it('accepts a FLOAT and a COLOR value', () => {
    expect(keyframeValueSchema.safeParse({ type: 'FLOAT', value: 120 }).success).toBe(true);
    expect(
      keyframeValueSchema.safeParse({ type: 'COLOR', value: { r: 1, g: 0, b: 0.5, a: 1 } }).success,
    ).toBe(true);
  });

  it('rejects a wrong-typed value, an unknown type, and an out-of-range color channel', () => {
    expect(keyframeValueSchema.safeParse({ type: 'FLOAT', value: 'nope' }).success).toBe(false);
    expect(keyframeValueSchema.safeParse({ type: 'MATRIX', value: 1 }).success).toBe(false);
    expect(
      keyframeValueSchema.safeParse({ type: 'COLOR', value: { r: 2, g: 0, b: 0, a: 1 } }).success,
    ).toBe(false);
  });
});

describe('manualKeyframeTrackInputSchema', () => {
  it('accepts a track with a baseValue and ordered keyframes', () => {
    expect(
      manualKeyframeTrackInputSchema.safeParse({
        baseValue: { type: 'FLOAT', value: 0 },
        keyframes: [
          { timelinePosition: 0, value: { type: 'FLOAT', value: 0 } },
          {
            timelinePosition: 0.3,
            value: { type: 'FLOAT', value: 120 },
            easing: { type: 'EASE_OUT' },
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects an empty keyframes array', () => {
    expect(manualKeyframeTrackInputSchema.safeParse({ keyframes: [] }).success).toBe(false);
  });
});

describe('keyframeFieldSchema', () => {
  it('accepts a PROPERTY field and an effects INDEXED_ITEM with a sub-field', () => {
    expect(keyframeFieldSchema.safeParse({ type: 'PROPERTY', name: 'TRANSLATION_X' }).success).toBe(
      true,
    );
    expect(
      keyframeFieldSchema.safeParse({
        type: 'INDEXED_ITEM',
        collection: 'effects',
        index: 0,
        field: 'RADIUS',
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown property name and an unknown discriminant', () => {
    expect(keyframeFieldSchema.safeParse({ type: 'PROPERTY', name: 'WOBBLE' }).success).toBe(false);
    expect(keyframeFieldSchema.safeParse({ type: 'GROUP', index: 0 }).success).toBe(false);
  });
});

describe('animationStyleConfigSchema', () => {
  it('accepts duration + timelineOffset (for stagger) + props', () => {
    expect(
      animationStyleConfigSchema.safeParse({
        duration: 0.4,
        timelineOffset: 0.1,
        props: { direction: 'right', distance: 120 },
      }).success,
    ).toBe(true);
  });

  it('rejects a non-positive duration', () => {
    expect(animationStyleConfigSchema.safeParse({ duration: 0 }).success).toBe(false);
  });
});

describe('custom easing without its parameters', () => {
  // Figma accepts both and reads back a value it does not play (spring: reads 0.25, plays linear;
  // bezier: reads (0,0,0.58,1), plays roughly (0.5,0,0.5,1)), so the input is refused instead.
  const kf = (easing: unknown): unknown => ({
    timelinePosition: 1,
    value: { type: 'FLOAT', value: 1 },
    easing,
  });
  const trackArgs = (easing: unknown): unknown => ({
    nodeId: '1:2',
    field: { type: 'PROPERTY', name: 'OPACITY' },
    track: { keyframes: [kf(easing)] },
  });
  const styleArgs = (easing: unknown): unknown => ({
    nodeId: '1:2',
    styleId: 's',
    config: { props: { easing } },
  });
  const cases = [
    { type: 'CUSTOM_SPRING', param: 'easingFunctionSpring', text: /bounce 0\.25.*LINEAR/ },
    {
      type: 'CUSTOM_CUBIC_BEZIER',
      param: 'easingFunctionCubicBezier',
      text: /\(0, 0, 0\.58, 1\).*\(0\.5, 0, 0\.5, 1\)/,
    },
  ] as const;

  for (const { type, param, text } of cases) {
    it(`refuses ${type} with the reason and the remedy, in a keyframe and in preset props`, () => {
      for (const parsed of [
        motionEasingSchema.safeParse({ type }),
        manualKeyframeTrackInputSchema.safeParse({ keyframes: [kf({ type })] }),
        animationStyleConfigSchema.safeParse({ props: { easing: { type } } }),
      ]) {
        expect(parsed.success).toBe(false);
        const issue = parsed.error?.issues[0];
        expect(issue?.path.at(-1)).toBe(param);
        expect(issue?.message).toMatch(text);
        expect(issue?.message).toMatch(/explicitly/);
        expect(issue?.message).toMatch(/LINEAR/);
      }
    });

    it(`refuses ${type} in a batch op and at the /rpc boundary`, () => {
      for (const [tool, args] of [
        ['apply_manual_keyframe_track', trackArgs({ type })],
        ['apply_animation_style', styleArgs({ type })],
      ] as const) {
        const op = checkBatchOps({ ops: [{ tool, params: args }] });
        expect(op?.code).toBe(ErrorCode.InvalidParams);
        expect(op?.message).toContain(param);
        expect(op?.message).toMatch(text);
        const rpc = checkWireCall(tool, args);
        expect(rpc?.code).toBe(ErrorCode.InvalidParams);
        expect(rpc?.message).toMatch(text);
        expect(checkWireCall('batch', { ops: [{ tool, params: args }] })?.message).toMatch(text);
      }
    });
  }

  it('accepts both with their parameters, and every other easing type bare', () => {
    const complete = [
      { type: 'CUSTOM_SPRING', easingFunctionSpring: { bounce: 0.25 } },
      { type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: { x1: 0, y1: 0, x2: 0.58, y2: 1 } },
      ...MOTION_EASING_TYPES.filter(t => !t.startsWith('CUSTOM_')).map(type => ({ type })),
    ];
    for (const easing of complete) {
      expect(motionEasingSchema.safeParse(easing).success).toBe(true);
      expect(
        checkBatchOps({
          ops: [{ tool: 'apply_manual_keyframe_track', params: trackArgs(easing) }],
        }),
      ).toBeNull();
      expect(checkWireCall('apply_animation_style', styleArgs(easing))).toBeNull();
    }
  });

  it('still accepts a keyframe with no easing at all', () => {
    expect(checkWireCall('apply_manual_keyframe_track', trackArgs(undefined))).toBeNull();
  });
});

describe('variable aliases in Motion slots', () => {
  const alias = { type: 'VARIABLE_ALIAS', id: 'VariableID:12:3' };
  const trackArgs = {
    nodeId: '1:2',
    field: { type: 'PROPERTY', name: 'OPACITY' },
    track: {
      keyframes: [{ timelinePosition: 1, value: { type: 'FLOAT', value: 1 }, easing: alias }],
    },
  };
  const styleArgs = {
    nodeId: '1:2',
    styleId: 's',
    config: { props: { easing: alias, delay: alias, duration: alias, distance: alias } },
  };

  it('accepts an alias in a keyframe easing and in any preset prop, keeping its id', () => {
    const track = applyManualKeyframeTrackTool.inputSchema.safeParse(trackArgs);
    expect(track.data).toEqual(trackArgs);
    const style = applyAnimationStyleTool.inputSchema.safeParse(styleArgs);
    expect(style.data).toEqual(styleArgs);
  });

  it('accepts them in a batch op and at the /rpc boundary', () => {
    for (const [tool, args] of [
      ['apply_manual_keyframe_track', trackArgs],
      ['apply_animation_style', styleArgs],
    ] as const) {
      expect(checkBatchOps({ ops: [{ tool, params: args }] })).toBeNull();
      expect(checkWireCall(tool, args)).toBeNull();
      expect(checkWireCall('batch', { ops: [{ tool, params: args }] })).toBeNull();
    }
  });

  it('refuses an alias without a string id everywhere', () => {
    for (const bad of [{ type: 'VARIABLE_ALIAS' }, { type: 'VARIABLE_ALIAS', id: 7 }]) {
      const track = {
        ...trackArgs,
        track: { keyframes: [{ ...trackArgs.track.keyframes[0], easing: bad }] },
      };
      const style = { ...styleArgs, config: { props: { delay: bad } } };
      expect(applyManualKeyframeTrackTool.inputSchema.safeParse(track).success).toBe(false);
      expect(applyAnimationStyleTool.inputSchema.safeParse(style).success).toBe(false);
      expect(checkWireCall('apply_manual_keyframe_track', track)?.code).toBe(
        ErrorCode.InvalidParams,
      );
      expect(checkBatchOps({ ops: [{ tool: 'apply_animation_style', params: style }] })?.code).toBe(
        ErrorCode.InvalidParams,
      );
    }
  });
});

describe('create_variable', () => {
  it('accepts the Motion resolvedTypes EASING and TIMING', () => {
    for (const resolvedType of ['EASING', 'TIMING']) {
      const args = { name: 'motion/enter', collectionId: 'VC:1', resolvedType };
      expect(createVariableTool.inputSchema.safeParse(args).success).toBe(true);
      expect(checkWireCall('create_variable', args)).toBeNull();
    }
  });
});

describe('set_variable_value with an EASING value', () => {
  // The EASING member was opened with create_variable, so it is one more input that takes a Motion
  // easing — and it must refuse a custom curve without its parameters exactly as the others do.
  const args = (value: unknown): unknown => ({ variableId: 'VariableID:1', modeId: '1:0', value });

  for (const [type, param] of [
    ['CUSTOM_SPRING', 'easingFunctionSpring'],
    ['CUSTOM_CUBIC_BEZIER', 'easingFunctionCubicBezier'],
  ] as const) {
    it(`refuses ${type} without ${param}, directly, in a batch op and at /rpc`, () => {
      const parsed = setVariableValueTool.inputSchema.safeParse(args({ type }));
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain(param);
      expect(JSON.stringify(parsed.error?.issues)).toContain('explicitly');
      expect(checkWireCall('set_variable_value', args({ type }))?.code).toBe(
        ErrorCode.InvalidParams,
      );
      expect(
        checkBatchOps({ ops: [{ tool: 'set_variable_value', params: args({ type }) }] })?.code,
      ).toBe(ErrorCode.InvalidParams);
    });
  }

  it('still accepts complete curves, named easings, aliases and every other value kind', () => {
    for (const value of [
      { type: 'CUSTOM_SPRING', easingFunctionSpring: { bounce: 0.25 } },
      { type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: { x1: 0, y1: 0, x2: 0.58, y2: 1 } },
      { type: 'EASE_OUT' },
      { type: 'VARIABLE_ALIAS', id: 'VariableID:2' },
      { r: 1, g: 0, b: 0, a: 1 },
      true,
      0.3,
      'label',
    ]) {
      expect(setVariableValueTool.inputSchema.safeParse(args(value)).success).toBe(true);
      expect(checkWireCall('set_variable_value', args(value))).toBeNull();
    }
  });
});
