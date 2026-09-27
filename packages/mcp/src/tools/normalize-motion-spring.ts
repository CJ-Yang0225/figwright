import { z } from 'zod';

import type { ToolSpec } from './spec.js';

export const NORMALIZE_MOTION_SPRING_TOOL_NAME = 'normalize_motion_spring';

export const normalizeMotionSpringTool: ToolSpec = {
  name: NORMALIZE_MOTION_SPRING_TOOL_NAME,
  description:
    "Convert a physical spring — mass, stiffness, damping — to Motion's normalized bounce, via " +
    "Figma's own figma.motion.physicalSpringToNormalized (the same conversion Figma itself uses). " +
    "Returns { bounce }, ready to use as CUSTOM_SPRING's easingFunctionSpring.bounce. There is no " +
    'initial-velocity parameter, and duration is not part of the conversion — the segment length is ' +
    'still yours to choose and verify. In practice the result depends only on the damping ratio: mass ' +
    'and stiffness scale together and cancel, and critical or over damping both give bounce 0, so the ' +
    "source spring's sense of speed does not carry over. This read runs in any editor whose plugin " +
    'API exposes Motion and errors in FigJam or where the API is missing.',
  inputSchema: z.object({
    mass: z.number().positive().describe('Spring mass, a positive finite number'),
    stiffness: z.number().positive().describe('Spring stiffness, a positive finite number'),
    damping: z.number().positive().describe('Spring damping, a positive finite number'),
  }),
  kind: 'read',
};
