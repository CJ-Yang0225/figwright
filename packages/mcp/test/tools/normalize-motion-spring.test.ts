import { describe, expect, it } from 'vitest';

import {
  NORMALIZE_MOTION_SPRING_TOOL_NAME,
  normalizeMotionSpringTool,
} from '../../src/tools/normalize-motion-spring.js';
import { ALL_TOOL_SPECS } from '../../src/tools/registry.js';
import { checkWireCall } from '../../src/tools/wire-schema.js';
import { toToolDefinition } from '../tool-schema.js';

const toolDefinition = toToolDefinition(normalizeMotionSpringTool);
// The advertised, strict schema — additionalProperties: false comes from registry.ts's strictArgs.
const advertisedSchema = ALL_TOOL_SPECS.find(
  s => s.name === NORMALIZE_MOTION_SPRING_TOOL_NAME,
)!.inputSchema;

const VALID = { mass: 1, stiffness: 100, damping: 10 };

describe('normalize_motion_spring tool definition', () => {
  it('requires mass / stiffness / damping, each a positive number', () => {
    expect(toolDefinition.name).toBe(NORMALIZE_MOTION_SPRING_TOOL_NAME);
    expect(toolDefinition.inputSchema).toMatchObject({
      type: 'object',
      required: ['mass', 'stiffness', 'damping'],
      properties: {
        mass: { type: 'number', exclusiveMinimum: 0 },
        stiffness: { type: 'number', exclusiveMinimum: 0 },
        damping: { type: 'number', exclusiveMinimum: 0 },
      },
    });
  });

  it('accepts a valid physical spring, direct and at the wire boundary', () => {
    expect(advertisedSchema.safeParse(VALID).success).toBe(true);
    expect(checkWireCall(NORMALIZE_MOTION_SPRING_TOOL_NAME, VALID)).toBeNull();
  });

  it.each([
    ['zero', { ...VALID, damping: 0 }],
    ['negative', { ...VALID, mass: -1 }],
    ['a missing field', { mass: 1, stiffness: 100 }],
    ['a string', { ...VALID, damping: '10' }],
  ])('rejects %s, direct and at the wire boundary', (_, args) => {
    expect(advertisedSchema.safeParse(args).success).toBe(false);
    expect(checkWireCall(NORMALIZE_MOTION_SPRING_TOOL_NAME, args)?.message).toMatch(
      NORMALIZE_MOTION_SPRING_TOOL_NAME,
    );
  });

  it('rejects an extra initialVelocity field before it ever reaches the plugin', () => {
    expect(advertisedSchema.safeParse({ ...VALID, initialVelocity: 0 }).success).toBe(false);
  });
});
