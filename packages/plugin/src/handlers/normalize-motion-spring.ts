import type { NormalizeMotionSpringResult } from '@figwright/shared';

import type { SandboxToolHandler } from '../dispatcher.js';
import { motionApi } from './motion-shared.js';

/**
 * Convert a physical spring to Motion's normalized bounce via Figma's own
 * physicalSpringToNormalized. A read: allowed wherever `figma.motion` exists, refused in FigJam
 * without ever reading `figma.motion`.
 */
export const createNormalizeMotionSpringHandler =
  (figmaCtx: typeof figma): SandboxToolHandler =>
  async params => {
    const p = (params ?? {}) as { mass?: unknown; stiffness?: unknown; damping?: unknown };
    if (typeof p.mass !== 'number') {
      throw new TypeError('normalize_motion_spring: mass must be a number');
    }
    if (typeof p.stiffness !== 'number') {
      throw new TypeError('normalize_motion_spring: stiffness must be a number');
    }
    if (typeof p.damping !== 'number') {
      throw new TypeError('normalize_motion_spring: damping must be a number');
    }

    const motion = motionApi(figmaCtx);
    if (typeof motion?.physicalSpringToNormalized !== 'function') {
      // No editor name here: the dispatcher appends it (see assertFigmaEditor).
      throw new Error('normalize_motion_spring: the Figma Motion API is not available here.');
    }
    const bounce = motion.physicalSpringToNormalized({
      mass: p.mass,
      stiffness: p.stiffness,
      damping: p.damping,
    });
    if (typeof bounce !== 'number' || !Number.isFinite(bounce) || bounce < 0 || bounce > 1) {
      throw new Error(
        `normalize_motion_spring: Figma returned bounce ${JSON.stringify(bounce)}, expected a ` +
          'finite number between 0 and 1.',
      );
    }
    const result: NormalizeMotionSpringResult = { bounce };
    return result;
  };
