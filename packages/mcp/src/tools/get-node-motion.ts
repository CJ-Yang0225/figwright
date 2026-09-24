import { z } from 'zod';

import type { ToolSpec } from './spec.js';

export const GET_NODE_MOTION_TOOL_NAME = 'get_node_motion';

export const getNodeMotionTool: ToolSpec = {
  name: GET_NODE_MOTION_TOOL_NAME,
  description:
    "Read one node's Figma Motion (animation) state: applied animation styles, all keyframe animations, " +
    'manual keyframe tracks, and the timelines it belongs to. Call it before editing to discover ' +
    'styleIds / timelineIds and existing keyframes; for every animated layer under a frame use ' +
    'get_motion_context. Returns { nodeId, motion: { animationStyles, animations, ' +
    'manualKeyframeTracks, timelines } }, raw as Figma returns it, with motion: null when the id ' +
    'does not resolve or names a node without Motion (a page) — the two are not told apart. ' +
    "Also returns playheadPosition — the editor's Motion playhead in seconds, present only " +
    'in the Figma Design editor with an active timeline. Use it as a keyframe timelinePosition when ' +
    'the user means "here", i.e. wherever they have scrubbed to.',
  inputSchema: z.object({
    nodeId: z.string().describe('Figma node id to read Motion state from'),
  }),
  kind: 'read',
};
