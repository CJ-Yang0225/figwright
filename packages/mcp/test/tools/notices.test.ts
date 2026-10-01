import type { CallToolResult } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

import {
  captureNotices,
  reportSkew,
  withEasingNotice,
  withLookupTimeoutNotice,
  withRolledBackMotionNotice,
  withStalePresetTargetNotice,
  withMotionWriteNotice,
  withSkewNotice,
} from '../../src/tools/notices.js';

const result = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] });
const NOTICE = 'Figwright plugin v0.3.0 is older than this server (v0.4.0).';

/** A content block's text, or '' — the union also covers image/audio/resource blocks. */
const textOf = (from: CallToolResult, index: number): string => {
  const block = from.content[index];
  return block !== undefined && block.type === 'text' ? block.text : '';
};

describe('captureNotices', () => {
  it('scopes a report to the call that caused it', async () => {
    const captured = await captureNotices(
      async () => {
        reportSkew(NOTICE);
        return result('{}');
      },
      (r, notices) => withSkewNotice(r, notices.skew),
    );

    expect(captured.content).toHaveLength(2);
  });

  it('carries the warning on the very first call, not from the call before', async () => {
    // The predecessor to this was a module-level "last notice seen", which had nothing recorded
    // when the first call ran — so the first tool call after the server started shipped unwarned.
    // That is the call most likely to be a write, and the one an agent is most likely to trust.
    let first: string | null = 'unset';
    await captureNotices(
      async () => {
        reportSkew(NOTICE);
        return result('{}');
      },
      (r, notices) => {
        first = notices.skew;
        return r;
      },
    );

    expect(first).toBe(NOTICE);
  });

  it('does not leak a warning into the next call', async () => {
    await captureNotices(
      async () => {
        reportSkew(NOTICE);
        return result('{}');
      },
      r => r,
    );

    // The plugin was updated between calls; this one must come back clean.
    let second: string | null = 'unset';
    await captureNotices(
      async () => result('{}'),
      (r, notices) => {
        second = notices.skew;
        return r;
      },
    );

    expect(second).toBeNull();
  });

  it('keeps the warning when a call reaches several plugins and any one is old', async () => {
    // ping and the map tools dispatch more than once; if any plugin involved is out of date the
    // result as a whole is unverified, so a later clean report must not clear an earlier warning.
    let notice: string | null = 'unset';
    await captureNotices(
      async () => {
        reportSkew(NOTICE);
        reportSkew(null);
        return result('{}');
      },
      (r, notices) => {
        notice = notices.skew;
        return r;
      },
    );

    expect(notice).toBe(NOTICE);
  });

  it('attaches the warning to a failure, where it explains the failure', async () => {
    // The loudest thing an out-of-date plugin does is answer METHOD_NOT_FOUND for a tool it
    // predates — nine of them for the last shipped build. Unattributed, an agent reads that as
    // "this tool is broken" and looks for another way round, which is the same misdirection as a
    // silent wrong write.
    await expect(
      captureNotices(
        async () => {
          reportSkew(NOTICE);
          throw new Error('METHOD_NOT_FOUND: no sandbox handler (method=export_video)');
        },
        r => r,
      ),
    ).rejects.toThrow(/METHOD_NOT_FOUND[\s\S]*OUT OF DATE[\s\S]*older than this server/);
  });

  it('leaves a failure untouched when the plugin is current', async () => {
    const original = new Error('node not found');
    await expect(
      captureNotices(
        () => Promise.reject(original),
        r => r,
      ),
    ).rejects.toBe(original);
  });

  it('ignores a report made outside any call', () => {
    // Election probes and the leader's own RPC endpoint dispatch with no tool call to attribute to.
    expect(() => reportSkew(NOTICE)).not.toThrow();
  });
});

describe('withSkewNotice', () => {
  it('appends the warning without disturbing the result the agent asked for', () => {
    const out = withSkewNotice(result('{"nodes":[]}'), NOTICE);

    expect(out.content).toHaveLength(2);
    expect(out.content[0]).toEqual({ type: 'text', text: '{"nodes":[]}' });
    expect(textOf(out, 1)).toContain(NOTICE);
  });

  it('separates the warning from the payload it warns about', () => {
    // Clients concatenate content blocks. Appended bare, the sentence runs straight on from the
    // result's closing brace and reads as part of the payload — seen against a real client, which
    // is why the separation is asserted rather than left to look right.
    const out = withSkewNotice(result('{"ok":true}'), NOTICE);
    const appended = textOf(out, 1);

    expect(appended.startsWith('\n\n')).toBe(true);
    expect(appended).toMatch(/OUT OF DATE/);
  });

  it('warns regardless of how the tool is labelled, since a notice means it dispatched', () => {
    // The spec's `kind` used to gate this, which was wrong: `local` marks a tool whose handler runs
    // on the server, not one that never talks to Figma, and eight of the ten dispatch —
    // component_map, token_map, icon_map, design_diff, the exports. Those are the grounding tools,
    // so the label was hiding the warning on the results most likely to be built on.
    expect(withSkewNotice(result('{"ok":true}'), NOTICE).content).toHaveLength(2);
    expect(withSkewNotice(result('{"components":[]}'), NOTICE).content).toHaveLength(2);
  });

  it('leaves a result alone when nothing dispatched', () => {
    // A filesystem-only tool never sets a notice, so it stays silent for the reason that holds —
    // nothing was asked of the plugin — rather than because of what it is called.
    const untouched = result('{"framework":"vue"}');
    expect(withSkewNotice(untouched, null)).toBe(untouched);
  });
});

describe('withEasingNotice', () => {
  const spring = (bounce: number): unknown => ({
    type: 'CUSTOM_SPRING',
    easingFunctionSpring: { bounce },
  });
  const bezier = (type: string, x2: number): unknown => ({
    type,
    easingFunctionCubicBezier: { x1: 0, y1: 0, x2, y2: 1 },
  });
  const motion = (...easings: unknown[]): unknown => ({
    animationStyles: [],
    animations: {},
    manualKeyframeTracks: {
      OPACITY: { keyframes: easings.map((easing, i) => ({ timelinePosition: i, easing })) },
    },
    timelines: [],
  });
  const nodeMotion = (m: unknown): CallToolResult =>
    result(JSON.stringify({ nodeId: '6:339', motion: m }));

  it('flags an unbounced-looking spring and a pointless bezier once, naming node and field', () => {
    const context = result(
      JSON.stringify({
        rootNodeId: '6:307',
        coverage: { status: 'complete' },
        nodes: [
          { nodeId: '6:339', motion: motion(spring(0.25)) },
          {
            nodeId: '6:335',
            motion: motion({ type: 'LINEAR' }, bezier('CUSTOM_CUBIC_BEZIER', 0.58)),
          },
          { nodeId: '6:343', motion: motion(spring(0.4)) },
        ],
      }),
    );
    const flagged = withEasingNotice('get_motion_context', context);

    expect(flagged.content).toHaveLength(2);
    expect(flagged.content[1]).toMatchObject({ annotations: { audience: ['assistant'] } });
    const text = textOf(flagged, 1);
    expect(text).toContain('- 6:339 manualKeyframeTracks.OPACITY.keyframes[0].easing');
    expect(text).toContain('- 6:335 manualKeyframeTracks.OPACITY.keyframes[1].easing');
    expect(text).not.toContain('6:343');
    // Each reason is stated once, above the places it applies to.
    expect(text.match(/CUSTOM_SPRING bounce 0\.25:/g)).toHaveLength(1);
    expect(text.match(/CUSTOM_CUBIC_BEZIER \(0, 0, 0\.58, 1\)/g)).toHaveLength(1);
    expect(text).toMatch(/LINEAR/);
    expect(text).toMatch(/written back/);
    expect(text).toMatch(/export_video/);
  });

  it('leaves unambiguous easings alone', () => {
    for (const m of [
      motion(spring(0.4)),
      motion({ type: 'GENTLE', easingFunctionSpring: { bounce: 0.25 } }),
      motion(bezier('EASE_OUT', 0.58)),
      // A bezier that was actually written with these points reads back at float32 precision.
      motion(bezier('CUSTOM_CUBIC_BEZIER', 0.5799999833106995)),
      null,
    ]) {
      expect(withEasingNotice('get_node_motion', nodeMotion(m)).content).toHaveLength(1);
    }
  });

  it('reads get_node_motion and leaves other tools, errors and non-JSON untouched', () => {
    expect(
      withEasingNotice('get_node_motion', nodeMotion(motion(spring(0.25)))).content,
    ).toHaveLength(2);
    expect(withEasingNotice('get_node', nodeMotion(motion(spring(0.25)))).content).toHaveLength(1);
    const failed = { ...nodeMotion(motion(spring(0.25))), isError: true };
    expect(withEasingNotice('get_node_motion', failed)).toBe(failed);
    expect(withEasingNotice('get_node_motion', result('not json')).content).toHaveLength(1);
  });

  it('rides alongside the existing notices without changing them', async () => {
    const captured = await captureNotices(
      async () => {
        reportSkew(NOTICE);
        return nodeMotion(motion(spring(0.25)));
      },
      (r, notices) => withEasingNotice('get_node_motion', withSkewNotice(r, notices.skew)),
    );
    expect(captured.content).toHaveLength(3);
    expect(textOf(captured, 1)).toContain(NOTICE);
    expect(textOf(captured, 2)).toContain('MOTION EASING');
    // The failure path never reaches finish, so a thrown error carries only the skew warning.
    await expect(
      captureNotices(
        async () => {
          reportSkew(NOTICE);
          throw new Error('boom');
        },
        (r, notices) => withEasingNotice('get_node_motion', withSkewNotice(r, notices.skew)),
      ),
    ).rejects.toThrow(/boom[\s\S]*OUT OF DATE/);
  });
});

describe('withMotionWriteNotice', () => {
  const WRITE_TOOLS = [
    'apply_animation_style',
    'remove_animation_style',
    'apply_manual_keyframe_track',
    'remove_manual_keyframe_track',
    'set_timeline_duration',
  ];

  it.each(WRITE_TOOLS)('appends the layer-id notice once to a successful %s result', name => {
    const out = withMotionWriteNotice(name, {}, result('{"ok":true}'));

    expect(out.content).toHaveLength(2);
    expect(out.content[1]).toMatchObject({ annotations: { audience: ['assistant'] } });
    expect(textOf(out, 1)).toMatch(/LAYER IDS MAY HAVE CHANGED/);
  });

  it('appends the notice to a successful export_video result, including path: null', () => {
    const out = withMotionWriteNotice(
      'export_video',
      { nodeId: '1:1', format: 'MP4', outPath: '/tmp/x.mp4' },
      result('{"nodeId":"1:1","format":"MP4","path":null,"reason":"static"}'),
    );

    expect(out.content).toHaveLength(2);
    expect(textOf(out, 1)).toMatch(/LAYER IDS MAY HAVE CHANGED/);
  });

  it('appends the notice once for a batch with one Motion op, and once for several', () => {
    const oneOp = withMotionWriteNotice(
      'batch',
      {
        ops: [
          { tool: 'set_fills', params: {} },
          { tool: 'apply_animation_style', params: {} },
        ],
      },
      result('{"ok":true,"results":[]}'),
    );
    expect(oneOp.content).toHaveLength(2);

    const twoOps = withMotionWriteNotice(
      'batch',
      {
        ops: [
          { tool: 'apply_manual_keyframe_track', params: {} },
          { tool: 'remove_animation_style', params: {} },
        ],
      },
      result('{"ok":true,"results":[]}'),
    );
    expect(twoOps.content).toHaveLength(2);
  });

  it('leaves a batch with no Motion op, a non-Motion write, and every Motion read alone', () => {
    const noMotionBatch = withMotionWriteNotice(
      'batch',
      {
        ops: [
          { tool: 'set_fills', params: {} },
          { tool: 'rename_node', params: {} },
        ],
      },
      result('{"ok":true,"results":[]}'),
    );
    expect(noMotionBatch.content).toHaveLength(1);

    expect(withMotionWriteNotice('set_fills', {}, result('{"ok":true}')).content).toHaveLength(1);

    for (const name of [
      'get_node_motion',
      'get_motion_context',
      'get_motion_styles',
      'normalize_motion_spring',
    ]) {
      expect(withMotionWriteNotice(name, {}, result('{"ok":true}')).content).toHaveLength(1);
    }
  });

  it('leaves an error result alone, even for a triggering tool', () => {
    const failed = { ...result('{"error":"nope"}'), isError: true };
    expect(withMotionWriteNotice('apply_animation_style', {}, failed)).toBe(failed);
    expect(
      withMotionWriteNotice('batch', { ops: [{ tool: 'apply_animation_style' }] }, failed),
    ).toBe(failed);
  });

  it('rides after the skew and easing notices without disturbing them', () => {
    const ambiguousMotion = {
      nodeId: '6:1',
      motion: {
        animationStyles: [],
        animations: {},
        manualKeyframeTracks: {
          OPACITY: {
            keyframes: [
              {
                timelinePosition: 0,
                easing: { type: 'CUSTOM_SPRING', easingFunctionSpring: { bounce: 0.25 } },
              },
            ],
          },
        },
        timelines: [],
      },
    };
    const withEarlier = withEasingNotice(
      'get_node_motion',
      withSkewNotice(result(JSON.stringify(ambiguousMotion)), NOTICE),
    );
    const out = withMotionWriteNotice('apply_animation_style', {}, withEarlier);

    expect(out.content).toHaveLength(4);
    expect(textOf(out, 0)).toBe(JSON.stringify(ambiguousMotion));
    expect(textOf(out, 1)).toContain(NOTICE);
    expect(textOf(out, 2)).toMatch(/MOTION EASING/);
    expect(textOf(out, 3)).toMatch(/LAYER IDS MAY HAVE CHANGED/);
  });
});

describe('withLookupTimeoutNotice', () => {
  // Figma's own text, verbatim as measured live while the by-id lookup was timing out.
  const FIGMA =
    'Unable to establish connection to Figma after 10 seconds. Please check your internet connection.';
  const HEADING = 'FIGMA GAVE UP LOOKING UP AN ID';
  const failWith = (err: unknown) => async (): Promise<CallToolResult> => {
    throw err;
  };
  const messageOf = async (run: Promise<CallToolResult>): Promise<string> =>
    run.then(
      () => '',
      (err: unknown) => (err as Error).message,
    );
  const count = (text: string, of: string): number => text.split(of).length - 1;

  it.each([
    ['on its own', FIGMA],
    ['behind the relay prefixes', `INTERNAL_ERROR: INTERNAL_ERROR: ${FIGMA}`],
    ['inside the batch wrapper', `batch: capture failed before any op was applied: ${FIGMA}`],
  ])('explains the timeout %s, once, keeping Figma’s text', async (_, raised) => {
    const message = await messageOf(withLookupTimeoutNotice(failWith(new Error(raised))));
    expect(message.startsWith(raised)).toBe(true);
    expect(count(message, HEADING)).toBe(1);
    expect(message).toContain('search_nodes');
    expect(message).toContain('re-run the Figwright plugin');
  });

  it('routes a variable or collection lookup to listing, not to retrying the id', async () => {
    // The by-id timeout has also hit variable-collection lookups for collections that existed.
    const message = await messageOf(
      withLookupTimeoutNotice(failWith(new Error(`delete_variable_collection: ${FIGMA}`))),
    );
    expect(message).toContain('For a variable or variable collection');
    expect(message).toContain('list them with get_variable_defs instead of retrying the id');
  });

  it('explains a bare-string rejection too', async () => {
    const message = await messageOf(withLookupTimeoutNotice(failWith(FIGMA)));
    expect(message.startsWith(FIGMA)).toBe(true);
    expect(count(message, HEADING)).toBe(1);
  });

  it('appends once even when the text repeats or the error passes through twice', async () => {
    const twice = await messageOf(
      withLookupTimeoutNotice(failWith(new Error(`${FIGMA}; rollback: ${FIGMA}`))),
    );
    expect(count(twice, HEADING)).toBe(1);
    const nested = await messageOf(
      withLookupTimeoutNotice(async () => withLookupTimeoutNotice(failWith(new Error(FIGMA)))),
    );
    expect(count(nested, HEADING)).toBe(1);
  });

  it('leaves other errors and every success result untouched', async () => {
    const other = new Error('rename_node: node 1:2 not found');
    await expect(withLookupTimeoutNotice(failWith(other))).rejects.toBe(other);
    const ok = result(`{"note":"${FIGMA}"}`);
    await expect(withLookupTimeoutNotice(async () => ok)).resolves.toBe(ok);
  });

  it('comes before the other notices when they ride on the same failure', async () => {
    const message = await messageOf(
      captureNotices(
        async () =>
          withLookupTimeoutNotice(async () => {
            reportSkew(NOTICE);
            throw new Error(FIGMA);
          }),
        r => r,
      ),
    );
    expect(message.indexOf(HEADING)).toBeLessThan(message.indexOf('PLUGIN OUT OF DATE'));
  });
});

describe('withStalePresetTargetNotice', () => {
  // Figma's own text, verbatim as measured live when a preset targeted a renumbered layer id.
  const FIGMA = 'in applyAnimationStyle: Failed to resolve applied Figma animation style: Position';
  const HEADING = 'THIS LAYER ID IS PROBABLY STALE';
  const failWith = (err: unknown) => async (): Promise<CallToolResult> => {
    throw err;
  };
  const messageOf = async (run: Promise<CallToolResult>): Promise<string> =>
    run.then(
      () => '',
      (err: unknown) => (err as Error).message,
    );
  const count = (text: string, of: string): number => text.split(of).length - 1;

  it.each([
    ['on its own', FIGMA],
    ['behind the relay prefixes', `INTERNAL_ERROR: INTERNAL_ERROR: ${FIGMA}`],
    ['inside a batch op failure', `batch: op 1 (apply_animation_style) failed: ${FIGMA}`],
  ])('explains the stale id %s, once, keeping Figma’s text', async (_, raised) => {
    const message = await messageOf(withStalePresetTargetNotice(failWith(new Error(raised))));
    expect(message.startsWith(raised)).toBe(true);
    expect(count(message, HEADING)).toBe(1);
    expect(message).toContain("re-read the frame's children");
    expect(message).toContain('one batch');
  });

  it('leaves a missing styleId, other errors and successes untouched', async () => {
    const missing = 'in applyAnimationStyle: No Figma animation style found for styleId: X';
    expect(await messageOf(withStalePresetTargetNotice(failWith(new Error(missing))))).toBe(
      missing,
    );
    const ok: CallToolResult = { content: [{ type: 'text', text: '{}' }] };
    expect(await withStalePresetTargetNotice(async () => ok)).toBe(ok);
  });

  it('does not stack when the error passes through twice', async () => {
    const once = await messageOf(withStalePresetTargetNotice(failWith(new Error(FIGMA))));
    const twice = await messageOf(withStalePresetTargetNotice(failWith(new Error(once))));
    expect(count(twice, HEADING)).toBe(1);
  });
});

describe('withRolledBackMotionNotice', () => {
  const HEADING = 'MOTION LAYER IDS MAY HAVE CHANGED';
  const failWith = (message: string) => async (): Promise<CallToolResult> => {
    throw new Error(message);
  };
  const messageOf = async (run: Promise<CallToolResult>): Promise<string> =>
    run.then(
      () => '',
      (err: unknown) => (err as Error).message,
    );
  const op = (tool: string): unknown => ({ tool, params: {} });
  // The plugin's own wording, as batch.ts throws it after undoing ops 0..i-1.
  const failedAt = (i: number, tool: string): string =>
    `INTERNAL_ERROR: batch: op ${i} (${tool}) failed, rolled back ${i} applied op(s): boom`;

  it('warns when a failed batch rolled back a Motion write', async () => {
    const args = { ops: [op('apply_animation_style'), op('apply_animation_style')] };
    const message = await messageOf(
      withRolledBackMotionNotice('batch', args)(failWith(failedAt(1, 'apply_animation_style'))),
    );
    expect(message.startsWith(failedAt(1, 'apply_animation_style'))).toBe(true);
    expect(message.split(HEADING)).toHaveLength(2);
    expect(message).toContain('rolled them back');
  });

  it('stays silent when nothing Motion was applied before the failure', async () => {
    const cases: [unknown[], string][] = [
      // Failed at op 0: nothing was applied.
      [[op('apply_animation_style')], failedAt(0, 'apply_animation_style')],
      // Only non-Motion ops were rolled back; the Motion op is the one that failed.
      [[op('rename_node'), op('apply_animation_style')], failedAt(1, 'apply_animation_style')],
      // Capture failed before any op was applied.
      [[op('apply_animation_style')], 'batch: capture failed before any op was applied: x'],
    ];
    for (const [ops, raised] of cases) {
      expect(await messageOf(withRolledBackMotionNotice('batch', { ops })(failWith(raised)))).toBe(
        raised,
      );
    }
  });

  it('ignores other tools, successes, and an error that already carries the notice', async () => {
    const raised = failedAt(1, 'apply_animation_style');
    const args = { ops: [op('apply_animation_style'), op('apply_animation_style')] };
    expect(
      await messageOf(withRolledBackMotionNotice('apply_animation_style', args)(failWith(raised))),
    ).toBe(raised);
    const ok: CallToolResult = { content: [{ type: 'text', text: '{}' }] };
    expect(await withRolledBackMotionNotice('batch', args)(async () => ok)).toBe(ok);
    const once = await messageOf(withRolledBackMotionNotice('batch', args)(failWith(raised)));
    const twice = await messageOf(withRolledBackMotionNotice('batch', args)(failWith(once)));
    expect(twice.split(HEADING)).toHaveLength(2);
  });
});
