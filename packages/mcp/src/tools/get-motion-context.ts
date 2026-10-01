import { z } from 'zod';

import type { ToolSpec } from './spec.js';

export const GET_MOTION_CONTEXT_TOOL_NAME = 'get_motion_context';

export const getMotionContextTool: ToolSpec = {
  name: GET_MOTION_CONTEXT_TOOL_NAME,
  description:
    'List every Figma Motion (animation) source under a node: the node and its whole subtree, ' +
    'hidden layers and instance children included, never deduped (each instance under its own ' +
    'instance-qualified id). Call it once per root you implement — only coverage.status "complete" ' +
    'with no nodes means nothing there animates; a missing motion summary in get_design_context ' +
    'does not. Returns { rootNodeId, coverage, diagnostics?, nodes: [{ nodeId, parentId, name, ' +
    'type, motion }] } for each node with an applied animation style or a keyframe; motion is ' +
    'get_node_motion’s raw read, except that manualKeyframeTracks keeps only the tracks animations ' +
    'does not already play as stored (a variable-bound easing). A call is bounded: "partial" ' +
    'coverage names why and lists ' +
    'pendingNodeIds, disjoint subtree roots to call it on next. Nodes on one timeline id share a ' +
    'clock. Loop, trigger and pivot are not in the data — never fill them in as if Figma had.',
  inputSchema: z.object({
    nodeId: z
      .string()
      .describe(
        'Frame or layer id whose subtree to inventory (a top-level frame covers its timeline)',
      ),
  }),
  kind: 'read',
};
