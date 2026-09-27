import { z } from 'zod';

import type { ToolSpec } from './spec.js';

export const CREATE_VARIABLE_TOOL_NAME = 'create_variable';

export const createVariableTool: ToolSpec = {
  name: CREATE_VARIABLE_TOOL_NAME,
  description:
    'Create a variable in a collection with resolvedType BOOLEAN / FLOAT / STRING / COLOR / EASING ' +
    '/ TIMING. Set per-mode values with set_variable_value, then attach it with ' +
    'bind_variable_to_node or bind_variable_to_paint. EASING (a Motion easing curve; starts as ' +
    'CUSTOM_CUBIC_BEZIER (0.5, 0, 0.5, 1)) and TIMING (a duration in seconds; starts at 0) drive ' +
    'Figma Motion: bind them as { type: "VARIABLE_ALIAS", id } — an EASING variable in a keyframe ' +
    "easing or a preset's props.easing, a TIMING variable in props.delay / props.duration of " +
    'apply_animation_style. Returns { ok, variableId, name }.',
  inputSchema: z.object({
    name: z.string().describe('Variable name, e.g. "color/primary"'),
    collectionId: z.string().describe('Variable collection id'),
    resolvedType: z
      .enum(['BOOLEAN', 'FLOAT', 'STRING', 'COLOR', 'EASING', 'TIMING'])
      .describe('Variable data type'),
  }),
  kind: 'write',
};
