// Shared helpers for the Motion (beta) handlers: the node-capability guard, the editor gate, a
// light keyframe-field check, and the raw read get_node_motion and get_motion_context share (a
// plain-JSON extractor plus the keyframe check). The Motion API lives on every
// SceneNode. Authoring is gated to the Figma Design editor; reads go wherever `figma.motion` is
// present, except FigJam, which is never asked.

import type { NodeMotion } from '@figwright/shared';

/** A node that exposes the Motion API. Every SceneNode does; PAGE / DOCUMENT do not. */
export type MotionNode = BaseNode & MotionNodeMixin;

/** Runtime guard: the Motion mixin methods are present on scene nodes, absent on PAGE / DOCUMENT. */
export const isMotionNode = (node: BaseNode): node is MotionNode => 'applyAnimationStyle' in node;

/**
 * Runtime guard for a read: the node carries Motion state. Keyed on the state, not on a write
 * method like {@link isMotionNode}, because a read-only editor may expose one without the other.
 */
export const hasMotionState = (node: BaseNode): node is MotionNode => 'animations' in node;

/**
 * Motion authoring and video export only work in the Figma Design editor. Throw a clear, actionable
 * error rather than letting the plugin API reject opaquely (or silently no-op) in FigJam / Dev
 * Mode. Writes only — reads go through {@link motionApi} instead.
 *
 * It deliberately does not name the current editor: every error leaving a handler passes through
 * the dispatcher, which appends `(editor: X — …)` for exactly the editors this gate fires in.
 * Naming it here as well produced "figjam" twice in one sentence — seen live before this was
 * trimmed.
 */
export const assertFigmaEditor = (figmaCtx: typeof figma, tool: string): void => {
  if (figmaCtx.editorType !== 'figma') {
    throw new Error(`${tool}: Figma Motion is only available in the Figma Design editor.`);
  }
};

/**
 * `figma.motion` for a read, or `undefined` where it is known to be unavailable: FigJam, whose
 * `figma.motion` has never been measured and so is never touched, and any editor that does not
 * expose the API. Keyed on the API's presence rather than `editorType === 'figma'`, so Dev Mode
 * reads whenever its plugin API carries Motion. An existence check, not try/catch: a getter or
 * method that throws still reaches the caller.
 */
export const motionApi = (figmaCtx: typeof figma): MotionAPI | undefined =>
  figmaCtx.editorType === 'figjam'
    ? undefined
    : (figmaCtx as { motion?: MotionAPI | undefined }).motion;

/**
 * The Motion timeline playhead in seconds, or `undefined` when there's nothing to report — no
 * active timeline, FigJam, or no Motion API at all. Editor-wide: every node, a page included, reads
 * the same value (measured live).
 */
export const readPlayheadPosition = (figmaCtx: typeof figma): number | undefined =>
  motionApi(figmaCtx)?.playheadPosition;

/**
 * Light semantic check the grounded MCP schema can't express: an effects INDEXED_ITEM must carry a
 * `field` or a `propertyId`. Keeps the common PROPERTY / fills / strokes paths untouched.
 */
export const assertKeyframeField = (field: unknown, tool: string): void => {
  if (typeof field !== 'object' || field === null) {
    throw new TypeError(`${tool}: field must be an object`);
  }
  const f = field as {
    type?: unknown;
    collection?: unknown;
    field?: unknown;
    propertyId?: unknown;
  };
  if (
    f.type === 'INDEXED_ITEM' &&
    f.collection === 'effects' &&
    f.field === undefined &&
    f.propertyId === undefined
  ) {
    throw new TypeError(`${tool}: an effects INDEXED_ITEM field needs "field" or "propertyId"`);
  }
};

interface AliasSite {
  path: string;
  id: unknown;
  /** The resolvedType the slot plays, or undefined where only existence has been measured. */
  needs: 'EASING' | 'TIMING' | undefined;
}

const isAlias = (value: unknown): value is { type: 'VARIABLE_ALIAS'; id?: unknown } =>
  typeof value === 'object' &&
  value !== null &&
  (value as { type?: unknown }).type === 'VARIABLE_ALIAS';

const propNeeds = (prop: string): AliasSite['needs'] =>
  prop === 'easing' ? 'EASING' : prop === 'delay' || prop === 'duration' ? 'TIMING' : undefined;

/** Every VARIABLE_ALIAS in a keyframe track or an animation-style config, with what it must be. */
const aliasSites = (input: { track?: unknown; config?: unknown }): AliasSite[] => {
  const sites: AliasSite[] = [];
  const keyframes = (input.track as { keyframes?: unknown } | undefined)?.keyframes;
  if (Array.isArray(keyframes)) {
    for (const [i, kf] of keyframes.entries()) {
      const easing = (kf as { easing?: unknown } | null)?.easing;
      if (isAlias(easing)) {
        sites.push({ path: `track.keyframes[${i}].easing`, id: easing.id, needs: 'EASING' });
      }
    }
  }
  const props = (input.config as { props?: unknown } | undefined)?.props;
  if (typeof props === 'object' && props !== null) {
    for (const [prop, value] of Object.entries(props)) {
      if (isAlias(value)) {
        sites.push({ path: `config.props.${prop}`, id: value.id, needs: propNeeds(prop) });
      }
    }
  }
  return sites;
};

const REMEDY = {
  EASING:
    'Bind an EASING variable (create one with create_variable, resolvedType EASING, and set its ' +
    'curve with set_variable_value), or pass a literal easing.',
  TIMING:
    'Bind a TIMING variable (create one with create_variable, resolvedType TIMING, and set its ' +
    'seconds with set_variable_value), or pass a literal number of seconds.',
} as const;

/**
 * Refuse a Motion variable binding whose variable is missing or of the wrong type for its slot — an
 * easing bound to anything but an EASING variable, a delay or duration to anything but a TIMING
 * one. Figma accepts both and reads them back as the alias given, so nothing downstream would
 * notice. Checked here because only the sandbox can see a variable's type; callers run it before
 * any mutation, direct and in batch capture alike.
 */
export const assertMotionAliases = async (
  figmaCtx: typeof figma,
  tool: string,
  input: { track?: unknown; config?: unknown },
): Promise<void> => {
  const sites = aliasSites(input);
  const variables = await Promise.all(
    sites.map(({ id }) =>
      typeof id === 'string' ? figmaCtx.variables.getVariableByIdAsync(id) : null,
    ),
  );
  for (const [i, { path, id, needs }] of sites.entries()) {
    const variable = variables[i] ?? null;
    if (variable === null) {
      throw new Error(
        `${tool}: ${path} is bound to variable ${String(id)}, which does not exist in this file. ` +
          (needs === undefined
            ? 'Use a local or already-imported variable id from get_variable_defs.'
            : REMEDY[needs]),
      );
    }
    if (needs !== undefined && variable.resolvedType !== needs) {
      throw new Error(
        `${tool}: ${path} is bound to "${variable.name}" (${variable.id}), a ` +
          `${variable.resolvedType} variable, but this slot takes ${needs === 'EASING' ? 'an' : 'a'} ` +
          `${needs} variable. ${REMEDY[needs]}`,
      );
    }
  }
};

/**
 * Deep-clone a plugin-API structure to plain JSON. Motion's animation / keyframe objects are plain
 * data keyed by field name; this shields the RPC envelope from any live proxy the API may hand
 * back.
 */
export const toPlainJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

/**
 * A node's raw Motion state — the one extractor get_node_motion and get_motion_context share, so a
 * node reads the same through either. Throws what the Motion getters throw; callers decide whether
 * that fails the call or becomes a diagnostic.
 */
export const readNodeMotion = (node: MotionNode): NodeMotion => ({
  animationStyles: toPlainJson(node.animationStyles) as unknown[],
  animations: toPlainJson(node.animations) as Record<string, unknown>,
  manualKeyframeTracks: toPlainJson(node.manualKeyframeTracks) as Record<string, unknown>,
  // The raw object first, so a field a later API adds survives; id and duration are then read
  // explicitly, so they survive even if the API hands back a Timeline whose fields don't enumerate.
  timelines: node.timelines.map(t => ({
    ...(toPlainJson(t) as object),
    id: t.id,
    duration: t.duration,
  })),
});

/** Whether any track anywhere in the structure holds a keyframe — shape-agnostic on purpose. */
export const hasKeyframe = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false;
  const keyframes = (value as { keyframes?: unknown }).keyframes;
  if (Array.isArray(keyframes) && keyframes.length > 0) return true;
  return Object.values(value).some(hasKeyframe);
};
