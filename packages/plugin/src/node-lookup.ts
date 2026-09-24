/** `I<outermost instance id>;…` — the first segment is a plain id Figma can look up. */
const INSTANCE_QUALIFIED = /^I([^;]+);/;

/**
 * Resolve an instance-qualified id (`I2:6;2:5`) from its outermost instance down, never handing it
 * to Figma's by-id lookup. Measured live (R7): in some plugin sessions `getNodeByIdAsync` on such
 * an id waits 10 s and rejects "Unable to establish connection to Figma", while the same session
 * resolves the instance root by id and walks its subtree normally. A miss resolves to null, exactly
 * as Figma's lookup would; any other id goes to Figma unchanged.
 */
export const resolveNodeById = async (
  figmaCtx: typeof figma,
  id: string,
): Promise<BaseNode | null> => {
  const root = INSTANCE_QUALIFIED.exec(id)?.[1];
  if (root === undefined) return figmaCtx.getNodeByIdAsync(id);
  const instance = await figmaCtx.getNodeByIdAsync(root);
  if (instance === null || !('findOne' in instance)) return null;
  // ponytail: a full walk of the instance per lookup; prune at nested-instance boundaries if a huge
  // instance ever makes this slow. With skipInvisibleInstanceChildren on, a hidden sublayer is
  // skipped here just as Figma's own lookup returns null for it.
  return instance.findOne(node => node.id === id);
};

/**
 * The Figma API every handler receives: identical to `figmaCtx` except that `getNodeByIdAsync` goes
 * through {@link resolveNodeById}. Wrapping here, where the handler map is built, covers every
 * handler and helper without touching their call sites. The proxy forwards to `figmaCtx` over an
 * empty target, so getters and setters (`skipInvisibleInstanceChildren`) run on the real API object
 * and no invariant of a frozen `figma` can be violated.
 */
export const withInstanceIdLookup = (figmaCtx: typeof figma): typeof figma => {
  const getNodeByIdAsync = async (id: string): Promise<BaseNode | null> =>
    resolveNodeById(figmaCtx, id);
  return new Proxy({} as typeof figma, {
    get: (_, prop) => {
      if (prop === 'getNodeByIdAsync') return getNodeByIdAsync;
      const value: unknown = Reflect.get(figmaCtx, prop);
      return typeof value === 'function' ? value.bind(figmaCtx) : value;
    },
    set: (_, prop, value) => Reflect.set(figmaCtx, prop, value),
    has: (_, prop) => Reflect.has(figmaCtx, prop),
  });
};
