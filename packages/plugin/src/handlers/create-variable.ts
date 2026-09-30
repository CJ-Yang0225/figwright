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
      scopes?: unknown;
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
    // The member names are checked against Figma's enum by the MCP tool schema, so this only has to
    // reject the wrong *shape* — an empty array would clear every scope, which Figma treats as a
    // variable offered nowhere rather than everywhere.
    if (p.scopes !== undefined) {
      if (
        !Array.isArray(p.scopes) ||
        p.scopes.length === 0 ||
        p.scopes.some(scope => typeof scope !== 'string')
      ) {
        throw new TypeError('create_variable: scopes must be a non-empty array of scope names');
      }
      // Figma refuses scopes on EASING / TIMING ("Cannot set scopes on this variable type", measured
      // 2026-09-30), but only when the property is assigned — after createVariable already ran. Refusing
      // here keeps the failed call from leaving an unscoped variable behind.
      if (p.resolvedType === 'EASING' || p.resolvedType === 'TIMING') {
        throw new TypeError(
          `create_variable: scopes cannot be set on ${p.resolvedType} variables — Figma refuses it; omit scopes`,
        );
      }
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

    // Scopes are set after creation: createVariable takes no scope argument, and assigning the
    // property is how Figma exposes it.
    if (p.scopes !== undefined) variable.scopes = p.scopes as VariableScope[];

    const result: VariableResult = { ok: true, variableId: variable.id, name: variable.name };
    return result;
  };
