import type { VariableResult } from '@figwright/shared';

import type { SandboxToolHandler } from '../dispatcher.js';

// Figma's VariableResolvedDataType. EASING and TIMING were refused by createVariable on 2026-08-08
// and accepted on 2026-10-02 (measured both times). A new EASING variable starts as
// CUSTOM_CUBIC_BEZIER (0.5, 0, 0.5, 1), a TIMING one at 0 seconds (measured).
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
    // property is how Figma exposes it. Figma refuses a scope that does not fit the type — "Invalid
    // scope for this variable type" for, say, CORNER_RADIUS on a COLOR, "Cannot set scopes on this
    // variable type" for any scope on EASING / TIMING (measured) — and by then the variable exists, so
    // a refusal removes it again: the call either creates the variable it describes or nothing.
    if (p.scopes !== undefined) {
      try {
        variable.scopes = p.scopes as VariableScope[];
      } catch (err) {
        variable.remove();
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `create_variable: Figma refused scopes ${JSON.stringify(p.scopes)} on the new ` +
            `${String(p.resolvedType)} variable (${reason}), so nothing was created. EASING and ` +
            'TIMING variables take no scopes; other types take only scopes that fit them.',
          { cause: err },
        );
      }
    }

    const result: VariableResult = { ok: true, variableId: variable.id, name: variable.name };
    return result;
  };
