type NativeAsyncLocalStorage<T> = {
  getStore(): T | undefined;
  run<R>(store: T, callback: () => R): R;
};

type NativeAsyncLocalStorageConstructor = new <T>() => NativeAsyncLocalStorage<
  T
>;

type NativeAsyncLocalStorageLoader = () => Promise<
  NativeAsyncLocalStorageConstructor
>;

/** A lazy native async context store; it never substitutes shared state. */
export type AsyncContextStorage<T> = Readonly<{
  getStore(): T | undefined;
  run<R>(store: T, callback: () => R): Promise<Awaited<R>>;
}>;

const ASYNC_HOOKS_SPECIFIER = "node:async_hooks";

async function loadNativeAsyncLocalStorage(): Promise<
  NativeAsyncLocalStorageConstructor
> {
  const module = await import(ASYNC_HOOKS_SPECIFIER) as {
    AsyncLocalStorage: NativeAsyncLocalStorageConstructor;
  };
  return module.AsyncLocalStorage;
}

/**
 * Loads the host's native AsyncLocalStorage only when a scoped run begins.
 * Keeping the import lazy lets authoring-only browser bundles load safely.
 */
export function createAsyncContextStorage<T>(
  load: NativeAsyncLocalStorageLoader = loadNativeAsyncLocalStorage,
): AsyncContextStorage<T> {
  let storage: NativeAsyncLocalStorage<T> | undefined;
  let loading: Promise<NativeAsyncLocalStorage<T>> | undefined;

  const getNativeStorage = async (): Promise<NativeAsyncLocalStorage<T>> => {
    if (storage) return storage;
    if (!loading) {
      loading = load().then((Constructor) => {
        storage = new Constructor<T>();
        return storage;
      }).catch((cause: unknown) => {
        loading = undefined;
        throw new Error(
          "This operation requires native AsyncLocalStorage support from node:async_hooks; this host does not provide it.",
          { cause },
        );
      });
    }
    return await loading;
  };

  return {
    getStore: () => storage?.getStore(),
    async run<R>(store: T, callback: () => R): Promise<Awaited<R>> {
      const nativeStorage = await getNativeStorage();
      return await nativeStorage.run(store, callback);
    },
  };
}
