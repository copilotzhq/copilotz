import { createTestDatabase } from "./ominipg.ts";

/** Explicit backend admission: this mode never constructs embedded storage. */
export async function createOwnerTestDatabase() {
  const selected = Deno.env.get("COPILOTZ_OWNER_TEST_POSTGRES_URL");
  if (selected === undefined) return await createTestDatabase();
  const url = new URL(selected);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new TypeError(
      "Connected PostgreSQL tests require an explicit PostgreSQL URL.",
    );
  }
  const name = `owner_connected_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = await createTestDatabase({ url: url.href, pgPoolMax: 1 });
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    url.pathname = `/${name}`;
    const database = await createTestDatabase({ url: url.href, pgPoolMax: 4 });
    console.log(
      `PostgreSQL-only admitted: ${url.protocol}//${url.hostname}:${url.port}${url.pathname}`,
    );
    let closing: Promise<void> | undefined;
    return {
      ...database,
      close() {
        return closing ??= (async () => {
          try {
            await database.close();
          } finally {
            try {
              await admin.query(`DROP DATABASE "${name}"`);
              console.log(`PostgreSQL-only dropped: ${name}`);
            } finally {
              await admin.close();
            }
          }
        })();
      },
    };
  } catch (error) {
    try {
      if (created) await admin.query(`DROP DATABASE "${name}"`);
    } finally {
      await admin.close();
    }
    throw error;
  }
}
