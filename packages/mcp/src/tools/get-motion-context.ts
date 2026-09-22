import { z } from 'zod';

import type { ToolSpec } from './spec.js';

export const GET_MOTION_CONTEXT_TOOL_NAME = 'get_motion_context';

export const getMotionContextTool: ToolSpec = {
  name: GET_MOTION_CONTEXT_TOOL_NAME,
  description:
    'Inventory every Figma Motion (animation) source under a node — the node and its whole ' +
    'subtree, hidden layers and each instance’s own children included, never deduped (two ' +
    'instances of one component are reported separately, under their instance-qualified ids). ' +
    'Call it once per root you implement: coverage.status "complete" with no nodes is the only ' +
    'evidence the subtree does not animate — a missing motion summary in get_design_context is ' +
    'not. Returns { rootNodeId, coverage, diagnostics?, nodes: [{ nodeId, parentId, name, type, ' +
    'motion }] }, listing only nodes with an applied animation style, at least one keyframe, or a ' +
    'field this build does not know; ' +
    'motion is exactly get_node_motion’s raw read (animationStyles, animations, ' +
    'manualKeyframeTracks, timelines), passed through as Figma returns it. Each call is bounded ' +
    '(nodes visited, output size): "partial" names the reasons (node-limit, payload-limit, ' +
    'read-error) and lists pendingNodeIds — disjoint roots of the subtrees not read, to call this ' +
    'tool on in turn before treating the inventory as whole. diagnostics flag a failed read, a ' +
    'node whose Motion alone exceeds one call (node-over-budget; get_node_motion reads it ' +
    'unbounded), and an animated field this build’s typings do not define (unknown-field: raw ' +
    'data included, meaning unverified). Group nodes into shared clocks by timeline id only; ' +
    'members outside this subtree are not read. The data carries no loop, trigger, pivot or ' +
    'playback policy — never fill those in as if Figma had. Takes a frame or layer id (a pasted ' +
    'Figma URL works); a page or document is rejected.',
  inputSchema: z.object({
    nodeId: z
      .string()
      .describe(
        'Frame or layer id whose subtree to inventory (a top-level frame covers its timeline)',
      ),
  }),
  kind: 'read',
};
