import test from "node:test";
import assert from "node:assert/strict";
import { createOwner } from "../dist/owner.mjs";
import { createCopilotzClient } from "@copilotz/copilotz/client";

test("installed Node gateway authorizes live reads and denies anonymous reads/public mutations", async () => {
  const capability = "synthetic-owner-test-capability";
  const owner = await createOwner({
    databaseUrl: ":memory:",
    databaseSchema: "demo_owner_test",
    capability,
  });
  const client = createCopilotzClient({
    baseUrl: "http://owner.test/api",
    getRequestHeaders: () => ({ authorization: `Bearer ${capability}` }),
    fetch: (input, init) => owner.app.fetch(new Request(input, init)),
  });
  const abort = new AbortController();
  try {
    const anonymous = await owner.app.fetch(
      new Request("http://owner.test/api/collections/demo_plan"),
    );
    assert.equal(anonymous.status, 403);
    const mutation = await owner.app.fetch(
      new Request("http://owner.test/api/collections/demo_plan", {
        method: "POST",
        headers: {
          authorization: `Bearer ${capability}`,
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    assert.ok([403, 404, 405].includes(mutation.status));
    let snapshot;
    await client.collections.observe("demo_plan", { query: { limit: 20 } }, {
      signal: abort.signal,
      onSnapshot(value) {
        snapshot = value;
        abort.abort();
      },
    }).catch((error) => {
      if (!abort.signal.aborted) throw error;
    });
    assert.equal(snapshot.reset, true);
    assert.deepEqual(snapshot.value, []);
  } finally {
    abort.abort();
    await owner.app.close();
  }
});
