import {
  DESIGN_CONTEXT_TOKEN_BUDGET,
  estimateResultTokens,
  type GetMotionContextResult,
  type MotionContextNode,
  type MotionCoverage,
  type MotionDiagnostic,
  type NodeMotion,
} from '@figwright/shared';

import type { SandboxToolHandler } from '../dispatcher.js';
import {
  hasKeyframe,
  isMotionNode,
  type MotionNode,
  readNodeMotion,
  unknownMotionFields,
} from './motion-shared.js';

// ponytail: unmeasured starting points, not tuned values. The visit cap mirrors
// DESIGN_CONTEXT_BAIL_NODES, so any tree get_design_context grounds whole is inventoried whole too;
// re-measure both on a real Motion file (read time per node, largest single-node payload).
const MAX_VISITED_NODES = 1500;
const MAX_DIAGNOSTICS = 20;
const MAX_MESSAGE_CHARS = 300;
// The client's budget, split: diagnostics are charged in estimated tokens (a CJK error message
// costs twice what an ASCII one of the same length does, so a character cap alone overran it),
// pending ids get a reserve plus whatever the nodes left unspent, and the envelope — root id and
// coverage — is small and fixed. Node entries get the rest. Tests pin the worst ASCII and CJK cases.
const DIAGNOSTIC_TOKEN_BUDGET = 4_000;
const PENDING_TOKEN_RESERVE = 1_500;
const ENVELOPE_TOKEN_RESERVE = 500;
const NODE_TOKEN_BUDGET =
  DESIGN_CONTEXT_TOKEN_BUDGET -
  DIAGNOSTIC_TOKEN_BUDGET -
  PENDING_TOKEN_RESERVE -
  ENVELOPE_TOKEN_RESERVE;

type Reason = NonNullable<MotionCoverage['reasons']>[number];

const childrenOf = (node: SceneNode): readonly SceneNode[] =>
  'children' in node ? (node as SceneNode & { children: readonly SceneNode[] }).children : [];

/** The walk itself. Synchronous by design: nothing else runs while it holds the flag lifted. */
const inventory = (root: MotionNode): GetMotionContextResult => {
  const nodes: MotionContextNode[] = [];
  const diagnostics: MotionDiagnostic[] = [];
  let diagnosticsOmitted = 0;
  let diagnosticTokens = 0;
  const diagnose = (d: MotionDiagnostic): void => {
    const entry = { ...d, message: d.message.slice(0, MAX_MESSAGE_CHARS) };
    const cost = estimateResultTokens(JSON.stringify(entry)) + 1;
    if (
      diagnostics.length < MAX_DIAGNOSTICS &&
      diagnosticTokens + cost <= DIAGNOSTIC_TOKEN_BUDGET
    ) {
      diagnostics.push(entry);
      diagnosticTokens += cost;
    } else diagnosticsOmitted += 1;
  };
  const reasons = new Set<Reason>();
  let visited = 0;
  let spent = 0;

  // Explicit pre-order stack: when a bound stops the walk, what is left on it is exactly the set of
  // unread subtree roots — disjoint, and together everything this call did not cover.
  const stack: SceneNode[] = [root as SceneNode];
  while (stack.length > 0) {
    if (visited === MAX_VISITED_NODES) {
      reasons.add('node-limit');
      break;
    }
    const node = stack.pop() as SceneNode;
    visited += 1;

    let motion: NodeMotion | null = null;
    try {
      if (isMotionNode(node)) motion = readNodeMotion(node);
    } catch (err) {
      // The root failing means the API itself is unusable here; say so instead of a hollow result.
      if (node === root) throw err;
      reasons.add('read-error');
      const message = err instanceof Error ? err.message : String(err);
      diagnose({ nodeId: node.id, code: 'read-error', message });
    }

    if (motion !== null) {
      const unknown = unknownMotionFields(motion);
      if (motion.animationStyles.length > 0 || hasKeyframe(motion) || unknown.length > 0) {
        const entry: MotionContextNode = {
          nodeId: node.id,
          parentId: node.parent?.id ?? null,
          name: node.name,
          type: node.type,
          motion,
        };
        const cost = estimateResultTokens(JSON.stringify(entry)) + 1;
        if (spent + cost > NODE_TOKEN_BUDGET && nodes.length > 0) {
          // It may fit in a call of its own: hand it back, subtree and all, before its children
          // are queued.
          reasons.add('payload-limit');
          stack.push(node);
          break;
        }
        if (spent + cost > NODE_TOKEN_BUDGET) {
          // Too large even alone — a retry could never return it, so it is not pending.
          reasons.add('payload-limit');
          diagnose({
            nodeId: node.id,
            code: 'node-over-budget',
            message:
              `This node's Motion alone is ~${cost} estimated tokens, over one call's budget. ` +
              "get_node_motion returns it unbounded, which may exceed your client's output cap.",
          });
        } else {
          spent += cost;
          nodes.push(entry);
          if (unknown.length > 0) {
            diagnose({
              nodeId: node.id,
              code: 'unknown-field',
              message:
                `Not a Motion field in the plugin typings this build knows: ${unknown.join(', ')}. ` +
                'Its raw data is included as read; its units and composition are unverified.',
            });
          }
        }
      }
    }

    const children = childrenOf(node);
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i] as SceneNode);
  }

  const coverage: MotionCoverage = {
    status: reasons.size > 0 ? 'partial' : 'complete',
    visitedNodes: visited,
    animatedNodes: nodes.length,
  };
  if (reasons.size > 0) coverage.reasons = [...reasons];
  // ponytail: roots past what the output can list have no continuation of their own; add a
  // { parentId, fromIndex } one if a real file ever reports pendingOmitted.
  const pending = stack.toReversed().map(n => n.id);
  let room = NODE_TOKEN_BUDGET - spent + PENDING_TOKEN_RESERVE;
  let listed = 0;
  for (const id of pending) {
    const cost = estimateResultTokens(JSON.stringify(id)) + 1;
    if (cost > room) break;
    room -= cost;
    listed += 1;
  }
  if (pending.length > 0) coverage.pendingNodeIds = pending.slice(0, listed);
  if (listed < pending.length) coverage.pendingOmitted = pending.length - listed;

  // Caveats ahead of the data: the reader is a model going top to bottom.
  return {
    rootNodeId: root.id,
    coverage,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    ...(diagnosticsOmitted > 0 ? { diagnosticsOmitted } : {}),
    nodes,
  } satisfies GetMotionContextResult;
};

/**
 * Inventory every Motion source under a node: the node and its whole subtree — hidden layers and
 * each instance's own children included, never deduped — read with the same extractor as
 * get_node_motion. Bounded by visit count and payload; whatever the bound cuts is reported as
 * disjoint pending subtree roots rather than dropped, and a failed or over-budget node becomes a
 * diagnostic rather than an absence.
 */
export const createGetMotionContextHandler =
  (figmaCtx: typeof figma): SandboxToolHandler =>
  async params => {
    const nodeId = (params as { nodeId?: unknown } | null)?.nodeId;
    if (typeof nodeId !== 'string') {
      throw new TypeError('get_motion_context: nodeId must be a string');
    }
    const root = await figmaCtx.getNodeByIdAsync(nodeId);
    if (root === null) {
      // ponytail: with the flag on (Dev Mode) a hidden instance sublayer cannot be looked up, even one
      // an earlier call listed as pending; lifting the flag across this await would leak it into
      // concurrent handlers. A per-call refcount could make that safe if Dev Mode ever needs it.
      throw new Error(
        `get_motion_context: node "${nodeId}" not found in this file. Check the id (a pasted Figma ` +
          'URL works too).' +
          (figmaCtx.skipInvisibleInstanceChildren
            ? ' This editor also hides invisible layers inside instances from plugins, so such a ' +
              'layer reads as missing here; the Figma Design editor can read it.'
            : ''),
      );
    }
    if (!isMotionNode(root)) {
      throw new Error(
        `get_motion_context: "${nodeId}" is a ${root.type}, which carries no Figma Motion. Pass a ` +
          'frame or layer id — a top-level frame covers its whole timeline.',
      );
    }

    // Dev Mode defaults skipInvisibleInstanceChildren to true, which drops hidden layers inside
    // instances from `children`: a hidden animated sublayer would vanish from a result still marked
    // complete. The flag is global and handlers run concurrently, so it is lifted only around the
    // synchronous walk. Pending ids are read inside it too, since an invisible instance child's node
    // object throws on any property access once the flag is back on.
    const skipping = figmaCtx.skipInvisibleInstanceChildren;
    figmaCtx.skipInvisibleInstanceChildren = false;
    try {
      return inventory(root);
    } finally {
      figmaCtx.skipInvisibleInstanceChildren = skipping;
    }
  };
