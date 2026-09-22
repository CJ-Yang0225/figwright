// Shared helpers for the Motion (beta) handlers: the node-capability guard, the editor gate, a
// light keyframe-field check, and the raw read get_node_motion and get_motion_context share (a
// plain-JSON extractor plus the keyframe and unknown-field checks). The Motion API lives on every
// SceneNode, but only in the Figma Design editor — FigJam / Dev Mode have no animation engine.

import type { NodeMotion } from '@figwright/shared';

/** A node that exposes the Motion API. Every SceneNode does; PAGE / DOCUMENT do not. */
export type MotionNode = BaseNode & MotionNodeMixin;

/** Runtime guard: the Motion mixin methods are present on scene nodes, absent on PAGE / DOCUMENT. */
export const isMotionNode = (node: BaseNode): node is MotionNode => 'applyAnimationStyle' in node;

/**
 * Motion authoring and video export only work in the Figma Design editor. Throw a clear, actionable
 * error rather than letting the plugin API reject opaquely (or silently no-op) in FigJam / Dev
 * Mode.
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
 * The Motion timeline playhead in seconds, or `undefined` when there's nothing to report — no
 * active timeline, or an editor with no animation engine at all. Gated on `editorType` rather than
 * try/catch so reads that deliberately don't assert the editor (get_node_motion) stay non-throwing
 * in FigJam / Dev Mode without swallowing a real error.
 */
export const readPlayheadPosition = (figmaCtx: typeof figma): number | undefined =>
  figmaCtx.editorType === 'figma' ? figmaCtx.motion.playheadPosition : undefined;

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

// Checked as complete records, so a typings bump that adds or drops a field fails typecheck here
// instead of the new field silently reading as known (or a removed one as unknown).
const PROPERTY_FIELDS = new Set(
  Object.keys({
    CORNER_RADIUS: true,
    STROKE_WEIGHT: true,
    STACK_SPACING: true,
    STACK_PADDING_LEFT: true,
    STACK_PADDING_TOP: true,
    STACK_PADDING_RIGHT: true,
    STACK_PADDING_BOTTOM: true,
    WIDTH: true,
    HEIGHT: true,
    RECTANGLE_TOP_LEFT_CORNER_RADIUS: true,
    RECTANGLE_TOP_RIGHT_CORNER_RADIUS: true,
    RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS: true,
    RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS: true,
    BORDER_TOP_WEIGHT: true,
    BORDER_BOTTOM_WEIGHT: true,
    BORDER_LEFT_WEIGHT: true,
    BORDER_RIGHT_WEIGHT: true,
    STACK_COUNTER_SPACING: true,
    OPACITY: true,
    GRID_ROW_GAP: true,
    GRID_COLUMN_GAP: true,
    TRANSLATION_X: true,
    TRANSLATION_Y: true,
    TRANSLATION_XY: true,
    ROTATION: true,
    SCALE_X: true,
    SCALE_Y: true,
    SCALE_XY: true,
    PATH_TRIM_START: true,
    PATH_TRIM_END: true,
  } satisfies Record<KeyframePropertyFieldName, true>),
);
const EFFECT_FIELDS = new Set(
  Object.keys({
    OFFSET_X: true,
    OFFSET_Y: true,
    RADIUS: true,
    SPREAD: true,
    COLOR: true,
    REFRACTION_RADIUS: true,
    SPECULAR_ANGLE: true,
    SPECULAR_INTENSITY: true,
    CHROMATIC_ABERRATION: true,
    SPLAY: true,
    REFRACTION_INTENSITY: true,
    START_RADIUS: true,
    NOISE_SIZE_X: true,
    NOISE_SIZE_Y: true,
    DENSITY: true,
    EFFECT_OPACITY: true,
    SECONDARY_COLOR: true,
  } satisfies Record<EffectKeyframeFieldName, true>),
);
const INDEXED_COLLECTIONS = new Set(['fills', 'strokes', 'effects']);

/**
 * Paths of animated fields the plugin typings this build compiled against don't define — Figma
 * adding a field to the beta, most likely. Their raw data is kept like any other; this only lets
 * the caller tell a known field from one whose units and composition nobody here has checked.
 */
export const unknownMotionFields = (motion: NodeMotion): string[] => {
  const out: string[] = [];
  for (const [source, fields] of [
    ['animations', motion.animations],
    ['manualKeyframeTracks', motion.manualKeyframeTracks],
  ] as const) {
    for (const [name, value] of Object.entries(fields)) {
      if (PROPERTY_FIELDS.has(name)) continue;
      if (!INDEXED_COLLECTIONS.has(name)) {
        out.push(`${source}.${name}`);
        continue;
      }
      if (name !== 'effects' || typeof value !== 'object' || value === null) continue;
      for (const [index, effect] of Object.entries(value)) {
        if (typeof effect !== 'object' || effect === null) continue;
        for (const field of Object.keys(effect)) {
          if (field !== 'properties' && !EFFECT_FIELDS.has(field)) {
            out.push(`${source}.effects.${index}.${field}`);
          }
        }
      }
    }
  }
  return out;
};
