import type { GetNodeMotionResult } from '@figwright/shared';

import type { SandboxToolHandler } from '../dispatcher.js';
import { isMotionNode, readNodeMotion, readPlayheadPosition } from './motion-shared.js';

/**
 * Read a node's Motion state (applied styles, animations, manual keyframe tracks, timelines). Reads
 * don't gate on editorType — a node with no Motion support just returns `motion: null`, which is
 * honest in FigJam / Dev Mode. The deep keyframe structures are cloned to plain JSON.
 */
export const createGetNodeMotionHandler =
  (figmaCtx: typeof figma): SandboxToolHandler =>
  async params => {
    const nodeId = (params as { nodeId?: unknown } | null)?.nodeId;
    if (typeof nodeId !== 'string') {
      throw new TypeError('get_node_motion: nodeId must be a string');
    }
    // Editor-wide, so it's reported even when this node has no Motion of its own.
    const playheadPosition = readPlayheadPosition(figmaCtx);
    const node = await figmaCtx.getNodeByIdAsync(nodeId);
    if (node === null || !isMotionNode(node)) {
      const miss: GetNodeMotionResult = { nodeId, motion: null };
      if (playheadPosition !== undefined) miss.playheadPosition = playheadPosition;
      return miss;
    }
    const result: GetNodeMotionResult = { nodeId: node.id, motion: readNodeMotion(node) };
    if (playheadPosition !== undefined) result.playheadPosition = playheadPosition;
    return result;
  };
