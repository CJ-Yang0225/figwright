/** `I<outermost instance id>;…` — the first segment is a plain id Figma can look up. */
const INSTANCE_QUALIFIED = /^I([^;]+);/;

/** Find an instance-qualified id under its outermost instance, as Figma's lookup would. */
const walkFromInstanceRoot = async (
  figmaCtx: typeof figma,
  root: string,
  id: string,
): Promise<BaseNode | null> => {
  const instance = await figmaCtx.getNodeByIdAsync(root);
  if (instance === null || !('findOne' in instance)) return null;
  // With skipInvisibleInstanceChildren on, a hidden sublayer is skipped here just as Figma's own
  // lookup returns null for it.
  return instance.findOne(node => node.id === id);
};

/**
 * The Figma API every handler receives: identical to `figmaCtx` except that `getNodeByIdAsync`
 * survives Figma's by-id lookup failing on an instance-qualified id (`I2:6;2:5`).
 *
 * Figma's own lookup goes first: walking costs time in proportion to the instance's size (measured
 * as whole get_node calls: ~25 ms through Figma's lookup, ~180 ms walking a 4,400-layer instance).
 * Figma's lookup has been seen to reject such an id after waiting 10 s while the instance root
 * still resolved; only then is the id resolved by walking from the root, and the rest of this
 * plugin run walks directly instead of waiting on Figma again. A plain id, and any lookup that does
 * not reject, behaves exactly as Figma's does.
 *
 * Wrapping here, where the handler map is built, covers every handler and helper without touching
 * their call sites. The proxy forwards to `figmaCtx` over an empty target, so getters and setters
 * (`skipInvisibleInstanceChildren`) run on the real API object.
 */
export const withInstanceIdLookup = (figmaCtx: typeof figma): typeof figma => {
  let byIdRejected = false;
  const getNodeByIdAsync = async (id: string): Promise<BaseNode | null> => {
    const root = INSTANCE_QUALIFIED.exec(id)?.[1];
    if (root === undefined) return figmaCtx.getNodeByIdAsync(id);
    if (byIdRejected) return walkFromInstanceRoot(figmaCtx, root, id);
    try {
      return await figmaCtx.getNodeByIdAsync(id);
    } catch {
      byIdRejected = true;
      return walkFromInstanceRoot(figmaCtx, root, id);
    }
  };
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
