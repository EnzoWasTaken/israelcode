import { lazy, type ComponentType, type LazyExoticComponent } from "react";

export interface LazySurface<P> {
  /** Render inside a `<Suspense>`; resolves at once after `preload()` settles. */
  Component: LazyExoticComponent<ComponentType<P>>;
  /** Start (or join) the chunk load; idempotent. */
  preload: () => Promise<unknown>;
  /** True once the chunk has loaded, so an open needn't wait. */
  ready: () => boolean;
}

/**
 * A surface Home never shows at start-up (a modal, a deck tool, World),
 * loaded on demand like `LazySettingsScreen`. Callers preload it on idle and
 * await `preload()` before opening, so its entrance measures the real body.
 */
export function lazySurface<M, K extends keyof M>(
  load: () => Promise<M>,
  name: K,
): LazySurface<M[K] extends ComponentType<infer P> ? P : never> {
  let pending: Promise<M> | null = null;
  let loaded = false;
  let module: M | null = null;
  const preload = (): Promise<M> => {
    pending ??= load().then(
      (loadedModule) => {
        loaded = true;
        module = loadedModule;
        return loadedModule;
      },
      (error: unknown) => {
        pending = null;
        throw error;
      },
    );
    return pending;
  };
  const pick = (loadedModule: M) => ({
    default: loadedModule[name] as ComponentType<M[K] extends ComponentType<infer P> ? P : never>,
  });
  // Once preloaded, hand React a thenable that settles synchronously, so the
  // first render mounts the real body instead of suspending for a microtask.
  const Component = lazy(() =>
    module
      ? (syncThenable(pick(module)) as Promise<ReturnType<typeof pick>>)
      : preload().then(pick),
  );
  return { Component, preload, ready: () => loaded };
}

/** Preload several surfaces; resolves when all have loaded (or one failed). */
export function preloadAll(
  surfaces: readonly { preload: () => Promise<unknown> }[],
): Promise<void> {
  return Promise.all(surfaces.map((s) => s.preload())).then(
    () => undefined,
    () => undefined,
  );
}

function syncThenable<T>(value: T): PromiseLike<T> {
  return {
    then: <R>(resolve?: ((v: T) => R | PromiseLike<R>) | null) =>
      syncThenable(resolve ? (resolve(value) as R) : (value as unknown as R)),
  } as PromiseLike<T>;
}
