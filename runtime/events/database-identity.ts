/** SQL facades retain the connection object's identity, never a URL or durable row. */
const databases = new WeakMap<object, object>();

export function sqlDatabaseIdentity(executor: object): object {
  return databases.get(executor) ?? executor;
}

/** Package-created adapters and transaction facades share their source lifetime. */
export function bindSqlDatabaseIdentity<T extends object>(
  executor: T,
  source: object,
): T {
  databases.set(executor, sqlDatabaseIdentity(source));
  return executor;
}
