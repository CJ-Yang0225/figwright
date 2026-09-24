import type { CallToolResult } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

import {
  captureNotices,
  reportSkew,
  withEasingNotice,
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
