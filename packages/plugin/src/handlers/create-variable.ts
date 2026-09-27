import type { VariableResult } from '@figwright/shared';

import type { SandboxToolHandler } from '../dispatcher.js';

// Figma's VariableResolvedDataType. EASING and TIMING were refused by createVariable until Plugin API
// Update 133 (2026-08-05) opened creating and editing them; measured working 2026-09-27. A new EASING
// variable starts as CUSTOM_CUBIC_BEZIER (0.5, 0, 0.5, 1), a TIMING one at 0 (seconds).
const RESOLVED_TYPES = ['BOOLEAN', 'FLOAT', 'STRING', 'COLOR', 'EASING', 'TIMING'] as const;
type ResolvedType = (typeof RESOLVED_TYPES)[number];

export const createCreateVariableHandler =
  (figmaCtx: typeof figma): SandboxToolHandler =>
  async params => {
    const p = (params ?? {}) as {
      name?: unknown;
      collectionId?: unknown;
      resolvedType?: unknown;
    };
    if (typeof p.name !== 'string') throw new TypeError('create_variable: name must be a string');
    if (typeof p.collectionId !== 'string') {
      throw new TypeError('create_variable: collectionId must be a string');
    }
    if (!RESOLVED_TYPES.includes(p.resolvedType as ResolvedType)) {
      throw new TypeError(
        `create_variable: resolvedType must be one of ${RESOLVED_TYPES.join(' / ')}`,
      );
    }

    const collection = await figmaCtx.variables.getVariableCollectionByIdAsync(p.collectionId);
    if (collection === null) {
      throw new Error(`create_variable: collection ${p.collectionId} not found`);
    }
    const variable = figmaCtx.variables.createVariable(
      p.name,
      collection,
      p.resolvedType as ResolvedType,
    );

    const result: VariableResult = { ok: true, variableId: variable.id, name: variable.name };
    return result;
  };
