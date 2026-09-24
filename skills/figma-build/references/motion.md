# Code → Motion (author animation in Figma)

The reverse of `figma-codegen`'s `references/motion.md`: when the source you're building from carries
animation — CSS `@keyframes` / `transition`, Framer Motion props, GSAP, a Vue/Svelte transition — author
it as Figma **Motion (beta)** on the frame you built, instead of dropping it to a static layout.

**Preconditions (check first, fail friendly):** Motion authoring only works in the **Figma Design**
editor, and keyframes attach to the layers of a **top-level frame** (a frame directly on the page).
Build the frame + its layers first, then animate them. FigJam / Dev Mode can't.

## Recognise the animation in the source

- **CSS** — `@keyframes name { … }` + `animation`, or a `transition` on enter/hover.
- **Framer Motion** — `initial` / `animate` / `variants`, `transition`, `whileHover`, `staggerChildren`.
- **GSAP** — `gsap.to/from/timeline`, `stagger`.
- **Vue / Svelte** — `<transition>` / `transition:` directives.

Read the real values from the source (the keyframe stops, the duration, the easing) — don't eyeball.

## Author it with the Motion tools

1. **`get_motion_styles`** first. If the animation is a common entrance (fade in, slide in from a
   direction), a preset likely matches → **`apply_animation_style`** with `config` tuning
   `duration` (seconds) and preset props (direction, distance). Prefer a preset over hand-keyframing
   when it fits — it's what a designer would reach for.
2. Otherwise **`apply_manual_keyframe_track`** per animated property. Map source → Figma field:

   | Source                                                      | Figma `field` (`{ type:'PROPERTY', name }`)        | `value` type       |
   | ----------------------------------------------------------- | -------------------------------------------------- | ------------------ |
   | `translateX/Y`, Framer `x`/`y`                              | `TRANSLATION_X` / `TRANSLATION_Y`                  | `FLOAT`            |
   | `translate(x, y)` together                                  | `TRANSLATION_XY`                                   | `VECTOR` `{x, y}`  |
   | `scale`                                                     | `SCALE_XY`                                         | `VECTOR` `{x, y}`  |
   | `scaleX/Y`                                                  | `SCALE_X` / `SCALE_Y`                              | `FLOAT`            |
   | `rotate` (deg)                                              | `ROTATION` (**degrees, sign flipped** — see below) | `FLOAT`            |
   | `opacity`                                                   | `OPACITY`                                          | `FLOAT`            |
   | `border-radius`, `border-width`, width/height, gap, padding | `CORNER_RADIUS` / `STROKE_WEIGHT` / `WIDTH` / …    | `FLOAT`            |
   | colour                                                      | an indexed `fills` item                            | `COLOR` (RGBA 0–1) |

   Each `track` = `{ baseValue, keyframes: [{ timelinePosition (s), value, easing? }] }`. A CSS
   `@keyframes` `%` stop → `timelinePosition = pct/100 * duration`.

   Measured against Figma's own render (Figwright Motion Test, 2026-09-22) — re-check if the beta
   changes:
   - **Easing belongs to the arriving keyframe.** A Figma keyframe's easing shapes the segment that
     ends at it; a CSS / WAAPI keyframe's timing function shapes the segment that starts at it. Put
     each source segment's easing on the keyframe at its end.
   - **ROTATION is degrees, positive = counterclockwise on screen**; CSS `rotate` is clockwise-positive,
     so `rotate(90deg)` → `ROTATION -90`. (The Rotation preset's description says radians; a manual
     track rendered degrees.)
   - Before the first keyframe its value holds, and after the last the last value holds — a delayed
     entrance needs no extra keyframe at 0 unless the value before it must differ.
   - Value types are enforced per field (a wrong one is refused), and a layer holds either `SCALE_XY`
     or `SCALE_X`/`SCALE_Y`, never both. Scale is about the layer's centre.

3. **`set_timeline_duration`** to match the source's total duration.

### Easing (reverse map)

- `linear` → `{ type: 'LINEAR' }`; `ease-in/out/in-out` → `EASE_IN` / `EASE_OUT` / `EASE_IN_AND_OUT`.
- `cubic-bezier(x1,y1,x2,y2)` → `{ type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: {x1,y1,x2,y2} }`.
- A **spring** (Framer `type:'spring'`, GSAP elastic) → `{ type: 'CUSTOM_SPRING', easingFunctionSpring: { bounce } }`
  (normalized 0–1), or a named preset (`GENTLE`/`QUICK`/`BOUNCY`/`SLOW`) when it's close. Figma stores
  only the type and bounce and stretches the spring over its segment (measured: one shape in normalized
  time over 0.5–2 s segments, settling by ~60 % of it; the shape follows the bounce alone, whatever the
  type), so a source spring's physical duration does not carry over — choose the segment length. To
  pick a bounce whose shape matches the source's, use the curve in the figma-codegen skill's
  `references/motion.md` (Springs): a measured fit, not Figma documentation, valid for bounce 0 and
  0.01–0.8. Say the result is an approximation and check the export.
- **Always pass the parameters.** `CUSTOM_CUBIC_BEZIER` without points and `CUSTOM_SPRING` without
  `bounce` are refused with an error, and nothing is written: Figma would default them and then play
  something other than what they read back (the spring plays linear). For a straight line use
  `LINEAR`; for Figma's default, write it out (`bounce: 0.25`, or points `0, 0, 0.58, 1`).

## Stagger → one atomic `batch` (the efficiency win)

A `staggerChildren`, a GSAP `stagger`, or per-index `animation-delay` over a row of N nodes → **one
`batch`** of N `apply_animation_style` ops, each with `config.timelineOffset = index * step`. That's a
single round-trip that's undoable as a unit (Cmd-Z once reverts the whole stagger) — don't fire N
sequential calls.

```jsonc
// batch ops for a 3-item staggered fade-in, step 0.1s
[
  {
    "tool": "apply_animation_style",
    "params": { "nodeId": "…A", "styleId": "…", "config": { "timelineOffset": 0 } },
  },
  {
    "tool": "apply_animation_style",
    "params": { "nodeId": "…B", "styleId": "…", "config": { "timelineOffset": 0.1 } },
  },
  {
    "tool": "apply_animation_style",
    "params": { "nodeId": "…C", "styleId": "…", "config": { "timelineOffset": 0.2 } },
  },
]
```

Manual keyframe tracks are also batchable (PROPERTY fields only). `set_timeline_duration` too.

## Verify

`export_video` the top-level frame to an MP4/GIF and check the motion reads right, or scrub the
timeline in Figma. Then it's the same render-and-diff loop as a static build. The export can render a
document state one to two minutes older than your last write: check that its duration matches the
timeline and that one value you just changed shows up before trusting it. Re-read with
`get_node_motion` after writing — Figma normalizes what it stores (below).

## Limits (be honest)

- **Motion is beta** and Figma-Design-only; if `apply_*` reports it's unavailable, say so — don't fake
  a static approximation and call it animated.
- **Units**: rotation in degrees with the sign flipped (above); colours RGBA 0–1.
- **Instance sublayers can't be animated** through the plugin API ("Cannot write animations to
  instance sublayers"). Animate the main component's layer (every instance plays it) or the instance
  itself.
- **What Figma normalizes without an error:** two keyframes at the same time keep only the later one;
  a keyframe past the timeline is kept but the timeline is not extended (`set_timeline_duration`);
  a negative `timelinePosition` is refused; replacing a track without ids gives it new track and
  keyframe ids, while writing back the `id`s it read (track and each keyframe) kept all of them (one
  round trip).
- **Layer ids can change under Motion** (seen live, cause not documented): after a keyframe-track
  write a layer appeared in its parent under a new id, and a video export re-created a frame's layers
  under new ids. The ids first returned kept resolving to the new layers, but an id picked up after
  one change stopped resolving after the next, and a read right after a write once returned the state
  before it. Re-read ids (`get_motion_context`, `search_nodes`) before writing again rather than
  reusing ones from before a write or an export.
- Author only what the source actually animates; don't invent motion the code didn't specify.
