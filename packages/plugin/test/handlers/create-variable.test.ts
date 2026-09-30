import type { VariableResult } from '@figwright/shared';
import { describe, expect, it, vi } from 'vitest';

import { createCreateVariableHandler } from '../../src/handlers/create-variable.js';

const withCollection = (collection: unknown): typeof figma =>
  ({
    variables: {
      getVariableCollectionByIdAsync: async () => collection,
      createVariable: () => ({}),
    },
  }) as unknown as typeof figma;

describe('create_variable handler', () => {
  it('creates a variable in the resolved collection', async () => {
    const collection = { id: 'VC:0' };
    const createVariable = vi.fn<(name: string) => { id: string; name: string }>(
      (name: string) => ({
        id: 'V:0',
        name,
      }),
    );
    const f = {
      variables: {
        getVariableCollectionByIdAsync: async () => collection,
        createVariable,
      },
    } as unknown as typeof figma;
    const handler = createCreateVariableHandler(f);
    const result = (await handler({
      name: 'color/primary',
      collectionId: 'VC:0',
      resolvedType: 'COLOR',
    })) as VariableResult;

    expect(createVariable).toHaveBeenCalledWith('color/primary', collection, 'COLOR');
    expect(result).toEqual({ ok: true, variableId: 'V:0', name: 'color/primary' });
  });

  // Figma opened EASING/TIMING creation in Plugin API Update 133, so both go through to Figma.
  it('creates the motion resolvedTypes EASING and TIMING', async () => {
    for (const resolvedType of ['EASING', 'TIMING']) {
      const collection = { id: 'VC:0' };
      const createVariable = vi.fn<() => unknown>(() => ({ id: 'V:1', name: 'motion/enter' }));
      const f = {
        variables: {
          getVariableCollectionByIdAsync: async () => collection,
          createVariable,
        },
      } as unknown as typeof figma;
      // eslint-disable-next-line no-await-in-loop -- two fixed cases, sequential is fine
      await createCreateVariableHandler(f)({
        name: 'motion/enter',
        collectionId: 'VC:0',
        resolvedType,
      });
      expect(createVariable).toHaveBeenCalledWith('motion/enter', collection, resolvedType);
    }
  });

  it('throws on bad resolvedType, missing collection, or bad input', async () => {
    await expect(
      createCreateVariableHandler(withCollection({ id: 'VC:0' }))({
        name: 'x',
        collectionId: 'VC:0',
        resolvedType: 'NOPE',
      }),
    ).rejects.toThrow(/resolvedType/);
    await expect(
      createCreateVariableHandler(withCollection(null))({
        name: 'x',
        collectionId: 'VC:9',
        resolvedType: 'COLOR',
      }),
    ).rejects.toThrow(/not found/);
    await expect(
      createCreateVariableHandler(withCollection(null))({ collectionId: 'VC:0' }),
    ).rejects.toThrow(/name/);
  });

  it("applies scopes to the new variable, and leaves Figma's default alone when omitted", async () => {
    const mk = (): {
      variable: { scopes: string[] };
      handler: ReturnType<typeof createCreateVariableHandler>;
    } => {
      const variable = { id: 'V:0', name: 'radius/md', scopes: ['ALL_SCOPES'] };
      const f = {
        variables: {
          getVariableCollectionByIdAsync: async () => ({ id: 'VC:0' }),
          createVariable: () => variable,
        },
      } as unknown as typeof figma;
      return { variable, handler: createCreateVariableHandler(f) };
    };

    const scoped = mk();
    await scoped.handler({
      name: 'radius/md',
      collectionId: 'VC:0',
      resolvedType: 'FLOAT',
      scopes: ['CORNER_RADIUS'],
    });
    expect(scoped.variable.scopes).toEqual(['CORNER_RADIUS']);

    // Omitted means "no opinion": Figma's own default stays rather than being overwritten with a
    // guess, which is what makes the field's absence in get_variable_defs meaningful too.
    const bare = mk();
    await bare.handler({ name: 'radius/md', collectionId: 'VC:0', resolvedType: 'FLOAT' });
    expect(bare.variable.scopes).toEqual(['ALL_SCOPES']);
  });

  // Figma accepts createVariable for these and only then refuses the scopes assignment, which would
  // strand a half-configured variable — so the handler has to refuse before creating anything.
  it('refuses scopes on EASING and TIMING before creating a variable', async () => {
    for (const resolvedType of ['EASING', 'TIMING']) {
      const createVariable = vi.fn<() => unknown>();
      const f = {
        variables: {
          getVariableCollectionByIdAsync: async () => ({ id: 'VC:0' }),
          createVariable,
        },
      } as unknown as typeof figma;
      // eslint-disable-next-line no-await-in-loop -- two fixed cases, sequential is fine
      await expect(
        createCreateVariableHandler(f)({
          name: 'motion/enter',
          collectionId: 'VC:0',
          resolvedType,
          scopes: ['ALL_SCOPES'],
        }),
      ).rejects.toThrow(new RegExp(`${resolvedType} variable`));
      expect(createVariable).not.toHaveBeenCalled();
    }
  });

  // An empty array is the interesting one: Figma reads it as "offered nowhere", so letting it
  // through would quietly hide the variable from every picker.
  it('rejects a scopes value that is not a non-empty array of names', async () => {
    for (const scopes of [[], 'CORNER_RADIUS', [1]]) {
      const createVariable = vi.fn<() => unknown>();
      const f = {
        variables: {
          getVariableCollectionByIdAsync: async () => ({ id: 'VC:0' }),
          createVariable,
        },
      } as unknown as typeof figma;
      await expect(
        createCreateVariableHandler(f)({
          name: 'x',
          collectionId: 'VC:0',
          resolvedType: 'FLOAT',
          scopes,
        }),
      ).rejects.toThrow(/non-empty array/);
      expect(createVariable).not.toHaveBeenCalled();
    }
  });
});
