import type { GetMotionStylesResult, MotionStyle } from '@figwright/shared';

import type { SandboxToolHandler } from '../dispatcher.js';
import { motionApi } from './motion-shared.js';

/**
 * List the file's Figma Motion animation-style presets (the templates apply_animation_style takes).
 * A read: allowed in any editor whose plugin API carries Motion, refused in FigJam or without it.
 * An empty list is a successful query that found no presets.
 */
export const createGetMotionStylesHandler =
  (figmaCtx: typeof figma): SandboxToolHandler =>
  async () => {
    const motion = motionApi(figmaCtx);
    if (typeof motion?.figmaAnimationStyles !== 'function') {
      // No editor name here: the dispatcher appends it (see assertFigmaEditor).
      throw new Error('get_motion_styles: the Figma Motion API is not available here.');
    }
    const styles: MotionStyle[] = motion.figmaAnimationStyles().map(s => {
      const style: MotionStyle = { styleId: s.styleId, name: s.name };
      if (s.description !== undefined) style.description = s.description;
      if (s.props !== undefined) style.props = { ...s.props };
      return style;
    });
    const result: GetMotionStylesResult = { styles };
    return result;
  };
