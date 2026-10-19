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

/** Native storage is allocated lazily, including the private execution identity. */
function createNativeAsyncContextStorage<T>(
  load: NativeAsyncLocalStorageLoader,
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

// An independent owner command/publication must not borrow its scheduler's stores.
// This factory is lazy: importing authoring code does not load node:async_hooks.
const executions = createNativeAsyncContextStorage<object>(
  loadNativeAsyncLocalStorage,
);

/** Package-only boundary; joined work keeps the current execution identity. */
export function runIndependentAsyncContext<T>(
  execute: () => T | Promise<T>,
): Promise<T> {
  return executions.run(Object.freeze({}), execute);
}

/** A binding is visible only in the independent execution that installed it. */
export function createAsyncContextStorage<T>(
  load: NativeAsyncLocalStorageLoader = loadNativeAsyncLocalStorage,
): AsyncContextStorage<T> {
  const storage = createNativeAsyncContextStorage<{
    execution: object | undefined;
    value: T;
  }>(load);
  return {
    getStore() {
      const binding = storage.getStore();
      return binding?.execution === executions.getStore()
        ? binding?.value
        : undefined;
    },
    run: (value, execute) =>
      storage.run({ execution: executions.getStore(), value }, execute),
  };
}
