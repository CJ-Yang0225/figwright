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
   - **Pick it by `styleId`** (`Position`, `Opacity`, …), never by `name`: `name` has been seen as an
     unexpanded localization key (`motion.preset_name.position`). The applied style reads back under
     a different `styleId` (`Position` read back as `CodeComponentId:2:24` every time in the test
     file), so find it in `get_node_motion`'s `animationStyles` by the `id` equal to the
     `appliedStyleId` the apply returned.
   - **Prop units are the preset's own.** Each `get_motion_styles` entry describes its props with
     type, default and unit (Rotation's `amount` in degrees, Scale's in %, `delay`/`duration` in
     seconds) — write props to that, not to the manual track's units.
   - **Set timing on one side.** `props.delay` and `config.timelineOffset` read back as the same
     value whichever one you write, and `props.duration` reads back as the style's `duration`.
     Written to both, **the props won**: Position with `duration 1, timelineOffset 0.2` and
     `props { delay 0.5, duration 0.8 }` read back `duration 0.8`, `timelineOffset 0.5`. That was
     measured on Position only; other presets' precedence is unmeasured.
   - **A refusal can name the wrong cause.** The error
     `Failed to resolve applied Figma animation style: Position` says the style could not be
     resolved, but the style exists. Seen on 2026-09-27 (Position and Opacity, on new top-level
     frames and rectangles inside them): when the target node already
     carried a manual keyframe track, and when another node in the same top-level frame already
     carried a manual track or a preset — a second preset in one frame included. Applying the preset
     first and the manual tracks after it worked, on the same node and on a sibling. On 2026-09-22
     the same file took a manual track and then four presets (one Opacity, three Position) on
     siblings of one frame without an error, so what triggers the refusal is not known. Before
     applying, check whether the frame already animates (`get_motion_context` on the top-level
     frame, or `get_node_motion` on the node for its `manualKeyframeTracks`); if it does, apply
     presets before manual tracks, or author the motion as manual tracks.
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
  type), so a source spring's physical duration does not carry over — choose the segment length either
  way.
  - Source gives **physical** spring parameters (`mass`/`stiffness`/`damping` — e.g. Framer Motion's
    `stiffness`/`damping`) → call `normalize_motion_spring` with them before writing the keyframe,
    and put the `bounce` it returns in `easingFunctionSpring`; that's Figma's own conversion, exact
    rather than approximated. Measured on one Figma build (2026-09-27, 15 inputs):
    `bounce = max(0, 1 − ζ)` with `ζ = damping / (2·√(mass·stiffness))`, so critical and over
    damping both give 0. Only the damping ratio carries over — stiffness (how fast the source
    spring is) does not; the segment length you choose sets the speed.
  - Source gives no physical parameters at all (a bare `type:'spring'`, GSAP elastic) → use the curve
    in the figma-codegen skill's `references/motion.md` (Springs) to pick a bounce whose shape matches:
    a measured fit, not Figma documentation, valid for bounce 0 and 0.01–0.8. Say the result is an
    approximation and check the export.
- **Always pass the parameters.** `CUSTOM_CUBIC_BEZIER` without points and `CUSTOM_SPRING` without
  `bounce` are refused with an error, and nothing is written: Figma would default them and then play
  something other than what they read back (the spring plays linear). For a straight line use
  `LINEAR`; for Figma's default, write it out (`bounce: 0.25`, or points `0, 0, 0.58, 1`).
- **Bind to a variable** when the source takes the easing or timing from a design token: pass
  `{ type: 'VARIABLE_ALIAS', id }` instead of the literal. A keyframe's `easing` and a preset's
  `props.easing` take an EASING variable; a preset's `props.delay` and `props.duration` take a TIMING
  variable (seconds); other preset props take any existing variable. `config.duration` and
  `config.timelineOffset` take numbers only. A variable of the wrong type, or one that does not
  exist, is refused before anything in Figma changes — Figma itself accepted such bindings, and a
  mistyped or missing keyframe easing then read back as LINEAR in `animations`. Find variables with
  `get_variable_defs`; create EASING / TIMING ones with `create_variable` and set their values with
  `set_variable_value` — with the full curve: an EASING value set as `CUSTOM_SPRING` without a
  bounce read back as bounce 0.25, the same trap as a keyframe's.

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

This stagger has both worked and failed in one file. On 2026-09-22 three Position presets applied
one by one to siblings of one frame all succeeded; on 2026-09-27 the second preset applied in one
frame was refused with the misleading error described under step 1 (direct calls; a
one-frame stagger `batch` was not run then). A `batch` is all-or-nothing, so one refused op rolls
the whole stagger back. If that happens, author the stagger as manual keyframe tracks instead — one
per node, its keyframe times shifted by `index * step` — which kept working in frames that already
animated.

## Edit or retime an existing track

"Make only the second card's fade-in start 0.3 s later, leave everything else alone."
`apply_manual_keyframe_track` replaces the whole track of that field, so rebuild the track from
what is there — never send only the keyframes you changed, or the rest of the track is lost.

1. **Read the whole track.** `get_node_motion` on the exact node: take the field's entry in
   `manualKeyframeTracks` — its track `id`, every keyframe (`id`, `timelinePosition`, `value`,
   `easing`) — and the timeline. If the motion comes from a preset instead (the node lists it in
   `animationStyles`, and its track in `animations` carries `animationPreset`), do not write the
   `animations` copy back as a manual track. A preset's timing is its `timelineOffset` and
   `duration`, and no tool edits an applied preset in place: `remove_animation_style` then
   `apply_animation_style` is two writes, gives the preset a new `appliedStyleId`, and the re-apply
   can meet the refusal under step 1 — say so before doing it.
2. **State the transform.** Shift, `t' = t + Δ`, or scale about an anchor, `t' = a + (t − a)·s`,
   applied only to the track and keyframes the user named. Keep each keyframe's `value`, its
   `easing` (an alias stays the same alias), and the `id`s you read. Without a clear anchor or range,
   ask instead of retiming the whole timeline.
3. **Re-read right before writing.** If the track no longer matches what you read in 1, the design
   changed: say so and recompute. This narrows the window; it is not a lock.
4. **Mind the timeline.** A keyframe past the timeline's end is kept but does not extend it.
   Extending affects every node in the frame, so say so, and write it in the same `batch` as the
   track (`set_timeline_duration` and `apply_manual_keyframe_track` both roll back). Never shorten
   the timeline to fit — that cuts other nodes' motion.
5. **Write, then re-read and compare** each target keyframe's time, value and easing, every other
   field on the node (unchanged), and the timeline's id and duration — not just `{ ok: true }`.
   What happens to ids, measured once each:
   - written back with the ids it read and **no time changed**: the track id and every keyframe id
     were kept;
   - written back with the ids it read and **times shifted** (+0.3 s on both keyframes): the track
     id was kept, but **every keyframe got a new id**.

   So match keyframes by order and time, not by id, and take the new ids from this read. A read
   right after writing a track on a second node of a frame came back empty (no tracks at all), and
   the next read showed the write — read again before concluding a write was lost. Anything else
   Figma rewrote or normalized: record it, and stop work that depends on it. As the
   `⚠️ MOTION LAYER IDS MAY HAVE CHANGED` notice on the write says, fetch layer ids again
   (`get_motion_context`, `search_nodes`) before the next write.

6. **Delete a keyframe** the same way: read the whole track, drop that keyframe, write the rest back.
   Dropping the last one means removing the track (`remove_manual_keyframe_track`, which `batch`
   refuses); never send an empty `keyframes` array.

Retiming a track whose easing is a variable alias has not been measured; compare the alias in
step 5.

## Verify

`export_video` the top-level frame to an MP4/GIF and check the motion reads right, or scrub the
timeline in Figma. Then it's the same render-and-diff loop as a static build. The export can render a
document state one to two minutes older than your last write: check that its duration matches the
timeline and that one value you just changed shows up before trusting it. Re-read with
`get_node_motion` after writing — Figma normalizes what it stores (below).

`design_diff` cannot verify a Motion write. It compares full, deduped `get_design_context`
snapshots, where Motion is only a summary — preset names, the names of animated fields and the
timeline length — so a changed keyframe time, value or easing, or a preset's config or props, can
come back `no-changes`; instance children the dedupe collapses carry no summary at all. Compare
`get_node_motion` (or `get_motion_context`) reads instead.

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
  keyframe ids, while writing back the `id`s it read (track and each keyframe) kept all of them when
  no time changed (one round trip) — with times changed, only the track id was kept (see "Edit or
  retime an existing track").
- **Lookups by id can time out** — Figma's own
  `Unable to establish connection to Figma after 10 seconds`, which Figwright follows with
  `⚠️ FIGMA GAVE UP LOOKING UP AN ID`. Seen for instance sublayers and for variable collections
  (`create_variable` into one, `delete_variable_collection`), including ids that exist; within one
  plugin session it has come and gone. Confirm a
  node by walking to it (`search_nodes`, `get_node` on its parent) and a variable or collection by
  listing (`get_variable_defs`) rather than retrying the same id; the notice says what to do next.
- **Layer ids can change under Motion** (seen live, cause not documented): after a keyframe-track
  write a layer appeared in its parent under a new id, and a video export re-created a frame's layers
  under new ids. The ids first returned kept resolving to the new layers, but an id picked up after
  one change stopped resolving after the next, and a read right after a write once returned the state
  before it. Re-read ids (`get_motion_context`, `search_nodes`) before writing again rather than
  reusing ones from before a write or an export. Every Motion write and `export_video` result now
  carries a fixed `⚠️ MOTION LAYER IDS MAY HAVE CHANGED` notice saying the same thing — it is a
  standing reminder, not a per-call detection, so it rides on every one of those results whether or
  not that particular call changed anything.
- Author only what the source actually animates; don't invent motion the code didn't specify.
