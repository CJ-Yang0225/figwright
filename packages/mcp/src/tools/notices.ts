import { AsyncLocalStorage } from 'node:async_hooks';

import type { CallToolResult } from '@modelcontextprotocol/server';

/**
 * Per-tool-call capture of the warnings that ride back on a result, so each belongs to the call it
 * is appended to.
 *
 * A module-level "last notice seen" was the first design and it was wrong twice over: the very
 * first call after the server starts had nothing recorded yet and so shipped unwarned — the single
 * most important call to get right — and internal dispatches (`ping` builds its own dispatch
 * context) never recorded at all. Async-local storage scopes it to the invocation instead, so
 * anything dispatched while a tool call is running reports into that call and nowhere else,
 * whatever layers sit between.
 *
 * Two warnings share the mechanism because they share the problem: both describe a way a result can
 * be wrong while looking completely normal — served by a plugin too old to have acted on every
 * argument, or served by a different Figma file than the agent believes it is working in. Neither
 * leaves a trace in the payload, so neither can be left for the caller to ask about.
 */
export interface NoticeBox {
  skew: string | null;
  routing: string | null;
}

const store = new AsyncLocalStorage<NoticeBox>();

/**
 * The block appended to whatever a tool call produced.
 *
 * The leading break and the heading are why it is a block rather than a bare sentence: clients
 * concatenate content blocks, so appended raw it runs straight on from the payload's closing brace
 * and reads as part of it. One definition for both the success and the failure path — they carry
 * the same words, and having written it twice is how a heading drifts between them.
 */
const asBlock = (notice: string): string => `\n\n⚠️ FIGWRIGHT PLUGIN OUT OF DATE\n${notice}`;

const asRoutingBlock = (notice: string): string =>
  `\n\n⚠️ MORE THAN ONE FIGMA FILE IS OPEN\n${notice}`;

/** Run a tool call with notice capture armed, then hand what was captured to `finish`. */
export const captureNotices = async (
  run: () => Promise<CallToolResult>,
  finish: (result: CallToolResult, notices: NoticeBox) => CallToolResult,
): Promise<CallToolResult> => {
  const box: NoticeBox = { skew: null, routing: null };
  try {
    const result = await store.run(box, run);
    return finish(result, box);
  } catch (err) {
    // A failure needs the warning as much as a result does — more, arguably: an out-of-date plugin
    // answers METHOD_NOT_FOUND for every tool it predates, and unattributed that reads as "this
    // tool is broken", so the agent goes looking for another way to do the same thing. The SDK
    // turns a thrown error into the tool result the model sees, so the message is where it has to
    // go; `finish` never runs on this path.
    const suffix =
      (box.routing === null ? '' : asRoutingBlock(box.routing)) +
      (box.skew === null ? '' : asBlock(box.skew));
    if (suffix === '') throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${message}${suffix}`, { cause: err });
  }
};

/**
 * Report the plugin that served a dispatch. A no-op outside a tool call — internal callers
 * (election probes, the leader's own RPC endpoint) dispatch with no call to attribute to.
 */
export const reportSkew = (notice: string | null): void => {
  const box = store.getStore();
  // Only ever set, never cleared: one tool call can dispatch to several plugins (a multi-call tool
  // pins one session, but ping and the map tools do not), and if any of them is out of date the
  // result as a whole is unverified.
  if (box !== undefined && notice !== null) box.skew = notice;
};

/**
 * Report that this call was routed by the foreground rather than by a claim, while more than one
 * file was open. Same set-once rule as the skew notice, and a no-op outside a tool call.
 */
export const reportRouting = (notice: string | null): void => {
  const box = store.getStore();
  if (box !== undefined && notice !== null) box.routing = notice;
};

/**
 * Append the ambiguous-routing warning to a tool result.
 *
 * The warning exists because the failure it describes is silent and the result looks perfect: with
 * two files open, an unclaimed agent's calls land in whichever one the user last touched, so the
 * agent can read one file, write to another, and report success. Nothing in the payload says which
 * file answered. An agent that has never heard of `use_file` would never think to ask — which is
 * precisely the agent this is for, since the feature is useless to anyone who does not know it is
 * there.
 */
export const withRoutingNotice = (
  result: CallToolResult,
  notice: string | null,
): CallToolResult => {
  if (notice === null) return result;
  return {
    ...result,
    content: [...result.content, { type: 'text' as const, text: asRoutingBlock(notice) }],
  };
};

/** The Motion reads whose payload carries keyframe easings as Figma stores them. */
const EASING_READ_TOOLS: ReadonlySet<string> = new Set(['get_node_motion', 'get_motion_context']);

const SPRING_WITHOUT_BOUNCE =
  'CUSTOM_SPRING bounce 0.25: either a real 0.25 spring or one written without a bounce, which ' +
  'Figma plays LINEAR. The record is identical either way (measured), so what plays is unknown.';
const BEZIER_WITHOUT_POINTS =
  'CUSTOM_CUBIC_BEZIER (0, 0, 0.58, 1) with x2 exactly 0.58: written without control points, and ' +
  'Figma plays it roughly as (0.5, 0, 0.5, 1), not the points it reports (measured). Points that ' +
  'were actually written read back at float32 precision (0.5799999833106995).';

/** Why an easing record may not be what Figma plays, or null when it is unambiguous. */
const ambiguousEasing = (easing: Record<string, unknown>): string | null => {
  if (easing.type === 'CUSTOM_SPRING') {
    const spring = easing.easingFunctionSpring as { bounce?: unknown } | undefined;
    return spring?.bounce === 0.25 ? SPRING_WITHOUT_BOUNCE : null;
  }
  if (easing.type === 'CUSTOM_CUBIC_BEZIER') {
    const p = easing.easingFunctionCubicBezier as Record<string, unknown> | undefined;
    // Exact equality is the test: Figma's own fill-in is the only way to read 0.58 unrounded.
    return p?.x1 === 0 && p.y1 === 0 && p.x2 === 0.58 && p.y2 === 1 ? BEZIER_WITHOUT_POINTS : null;
  }
  return null;
};

/** Each ambiguous easing under one node's Motion record, as `nodeId path`, grouped by reason. */
const findAmbiguousEasings = (
  nodeId: string,
  value: unknown,
  path: string,
  out: Map<string, string[]>,
): void => {
  if (Array.isArray(value)) {
    value.forEach((item, i) => findAmbiguousEasings(nodeId, item, `${path}[${i}]`, out));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const reason = ambiguousEasing(record);
  if (reason !== null) out.set(reason, [...(out.get(reason) ?? []), `${nodeId} ${path}`]);
  for (const [key, child] of Object.entries(record)) {
    findAmbiguousEasings(nodeId, child, path === '' ? key : `${path}.${key}`, out);
  }
};

/**
 * Warn about Motion easings whose record does not say what Figma plays.
 *
 * Refusing the incomplete input (motionEasingSchema) stops new ones, but the file may already hold
 * them — written by Figma's own UI, another tool, or before the refusal — and the read passes them
 * through raw. An agent implementing or copying that record has no way to know, so the warning
 * rides on the result itself, once per result, naming each affected node and field.
 */
export const withEasingNotice = (toolName: string, result: CallToolResult): CallToolResult => {
  if (!EASING_READ_TOOLS.has(toolName) || result.isError === true) return result;
  const first = result.content[0];
  if (first?.type !== 'text') return result;
  let payload: { nodeId?: unknown; motion?: unknown; nodes?: unknown };
  try {
    payload = JSON.parse(first.text) as typeof payload;
  } catch {
    // Not JSON is not a Motion read; there is nothing to inspect.
    return result;
  }
  const nodes = Array.isArray(payload.nodes) ? (payload.nodes as (typeof payload)[]) : [payload];
  const found = new Map<string, string[]>();
  for (const node of nodes) findAmbiguousEasings(String(node.nodeId), node.motion, '', found);
  if (found.size === 0) return result;
  const groups = [...found].map(([reason, at]) => `${reason}\n${at.map(a => `- ${a}`).join('\n')}`);
  const text =
    '\n\n⚠️ MOTION EASING MAY NOT BE WHAT FIGMA PLAYS\n' +
    `${groups.join('\n')}\n` +
    'Do not implement these curves from the record alone, and do not copy them to another node ' +
    'as-is: writing such a record can change the animation (an unbounced spring written back ' +
    'becomes a real 0.25 spring, measured). To see what plays, export_video the frame, check the ' +
    'export is current (its duration matches the timeline and a recent change shows), then ' +
    'measure it. When writing, pass the curve you mean explicitly — LINEAR if it plays linear.';
  return {
    ...result,
    content: [...result.content, { type: 'text', text, annotations: { audience: ['assistant'] } }],
  };
};

/**
 * Append the plugin-skew warning to a tool result.
 *
 * This is the whole mechanism that replaced refusing an old plugin: the call runs, and the agent is
 * told on the same turn that the result may be incomplete. It has to ride on every affected result
 * rather than be available on request, because the failure it describes is invisible — an older
 * handler drops arguments it predates and still answers `{ ok: true }`, so nothing in the payload
 * hints that anything is missing, and an agent with no reason to ask never asks.
 *
 * A non-null `notice` is itself the proof that this call reached the plugin: it can only have been
 * set by a dispatch. Filtering on the spec's `kind` as well was both redundant and wrong — `local`
 * marks a tool whose _handler_ runs on the server, not one that never talks to Figma, and all but
 * two of them wear that label while dispatching (`component_map`, `token_map`, `icon_map`,
 * `design_diff`, `use_file`, the export and save tools). Those are the grounding tools, so
 * suppressing their warning hid it on exactly the results most likely to be built on. The two
 * exceptions, `analyze_project` and `scan_components`, really are filesystem-only and stay silent
 * for the reason that actually holds: nothing dispatched, so there is nothing to attribute.
 */
export const withSkewNotice = (result: CallToolResult, notice: string | null): CallToolResult => {
  if (notice === null) return result;
  return {
    ...result,
    content: [...result.content, { type: 'text' as const, text: asBlock(notice) }],
  };
};
