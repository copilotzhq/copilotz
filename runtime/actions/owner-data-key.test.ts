import { assertEquals, assertRejects } from "@std/assert";
import { testSecretAdapter } from "../testing/secret-adapter.ts";
import {
  ownerDataCipher,
  rewrapOwnerDataKey,
  wrapOwnerDataKey,
} from "./owner-data-key.ts";
import { additionalAuthenticatedData } from "./protected-value.ts";

Deno.test("owner data encryption survives rewrapping and rejects another owner, schema or slot", async () => {
  const source = await testSecretAdapter(),
    destination = await testSecretAdapter();
  const row = await wrapOwnerDataKey(
    "scope_a",
    "key-a",
    crypto.getRandomValues(new Uint8Array(64)),
    source,
  );
  const cipher = await ownerDataCipher("scope_a", row, source);
  const coordinates = { namespace: "space", ownerId: "record", slot: "input" };
  const aad = additionalAuthenticatedData("scope_a", coordinates),
    plaintext = new TextEncoder().encode("private-value");
  const sealed = await cipher.seal({
    plaintext,
    additionalAuthenticatedData: aad,
  });
  const rewrapped = await rewrapOwnerDataKey(
    "scope_a",
    row,
    source,
    destination,
  );
  const moved = await ownerDataCipher("scope_a", rewrapped, destination);
  assertEquals(
    await moved.open({ ...sealed, additionalAuthenticatedData: aad }),
    plaintext,
  );
  assertEquals(
    (await moved.seal({ plaintext, additionalAuthenticatedData: aad }))
      .commitment,
    sealed.commitment,
  );
  await assertRejects(() => ownerDataCipher("scope_a", rewrapped, source));
  await assertRejects(() => ownerDataCipher("scope_b", rewrapped, destination));
  for (
    const changed of [{ ...coordinates, ownerId: "other" }, {
      ...coordinates,
      namespace: "other",
    }, { ...coordinates, slot: "output" }]
  ) {
    await assertRejects(async () =>
      await moved.open({
        ...sealed,
        additionalAuthenticatedData: additionalAuthenticatedData(
          "scope_a",
          changed,
        ),
      })
    );
  }
  const other = await wrapOwnerDataKey(
    "scope_a",
    "key-b",
    crypto.getRandomValues(new Uint8Array(64)),
    destination,
  );
  await assertRejects(async () =>
    await (await ownerDataCipher("scope_a", other, destination)).open({
      ...sealed,
      additionalAuthenticatedData: aad,
    })
  );
  await assertRejects(async () =>
    await moved.open({
      ...sealed,
      envelope: { iv: sealed.envelope.iv },
      additionalAuthenticatedData: aad,
    })
  );
});
