import { assertEquals, assertRejects } from "@std/assert";
import {
  createFilesystemBodyStore,
  digestContent,
  readBodyBytes,
} from "../../content/index.ts";
import { denoAssetFilesystem, denoAssetFilesystemTesting } from "./assets.ts";

Deno.test("Deno filesystem asset capability stores immutable bodies behind an atomic manifest", async () => {
  const root = await Deno.makeTempDir({ prefix: "copilotz-assets-" });
  try {
    const firstStore = createFilesystemBodyStore({
      backendId: "filesystem:test",
      protectionMs: 60_000,
      access: denoAssetFilesystem(root),
    });
    const secondStore = createFilesystemBodyStore({
      backendId: "filesystem:test",
      protectionMs: 60_000,
      access: denoAssetFilesystem(root),
    });
    const bytes = new TextEncoder().encode("hello");
    const digest = await digestContent(bytes);
    const input = {
      bodyId: "schemas/test/assets/asset-a",
      bytes,
      mediaType: "text/plain",
      digest,
      ifAbsent: true,
    } as const;
    const first = await firstStore.put({
      ...input,
      protectedUntil: "2000-01-01T00:00:00.000Z",
    });
    const renewed = await secondStore.put(input);
    assertEquals(renewed.byteLength, 5);
    assertEquals(renewed.maintenanceVersion, first.maintenanceVersion + 1);
    assertEquals(Date.parse(renewed.protectedUntil!) > Date.now(), true);
    const kept = await firstStore.put({
      ...input,
      protectedUntil: "2000-01-01T00:00:00.000Z",
    });
    assertEquals(kept.maintenanceVersion, renewed.maintenanceVersion + 1);
    assertEquals(kept.protectedUntil, renewed.protectedUntil);
    assertEquals(
      await readBodyBytes(secondStore, { bodyId: renewed.bodyId }),
      bytes,
    );
    assertEquals(
      await firstStore.maintenance.delete({
        bodyId: first.bodyId,
        expectedState: "ready",
        expectedMaintenanceVersion: first.maintenanceVersion,
        idleForMs: 0,
      }),
      false,
    );
    await assertRejects(() =>
      firstStore.put({
        ...input,
        bytes: new TextEncoder().encode("other"),
        digest:
          "sha256:d9298a10d1b0735837dc4bd85dac641b0f47d9f29876fb67e5d04a701a3d65b0",
      })
    );

    const collectableBytes = new TextEncoder().encode("collectable");
    const collectable = await firstStore.put({
      bodyId: "schemas/test/assets/asset-b",
      bytes: collectableBytes,
      mediaType: "text/plain",
      digest: await digestContent(collectableBytes),
      protectedUntil: "2000-01-01T00:00:00.000Z",
    });
    assertEquals(
      await secondStore.maintenance.delete({
        bodyId: collectable.bodyId,
        expectedState: "ready",
        expectedMaintenanceVersion: collectable.maintenanceVersion,
        idleForMs: 60_000,
      }),
      false,
    );
    assertEquals(
      await secondStore.maintenance.delete({
        bodyId: collectable.bodyId,
        expectedState: "ready",
        expectedMaintenanceVersion: collectable.maintenanceVersion,
        idleForMs: 0,
      }),
      true,
    );
    assertEquals(
      await firstStore.head({ bodyId: collectable.bodyId }),
      null,
    );

    const listed = await firstStore.maintenance.list({
      states: ["ready"],
      idleForMs: 0,
      limit: 10,
    });
    assertEquals(listed.bodies.map((item) => item.bodyId), [
      "schemas/test/assets/asset-a",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Deno filesystem acquire and maintenance delete are one versioned race", async () => {
  const root = await Deno.makeTempDir({ prefix: "copilotz-assets-race-" });
  try {
    const acquiring = createFilesystemBodyStore({
      backendId: "filesystem:race",
      protectionMs: 0,
      access: denoAssetFilesystem(root),
    });
    const maintaining = createFilesystemBodyStore({
      backendId: "filesystem:race",
      protectionMs: 0,
      access: denoAssetFilesystem(root),
    });
    const bytes = new TextEncoder().encode("race-safe");
    const input = {
      bodyId: "schemas/test/assets/race",
      bytes,
      mediaType: "text/plain",
      digest: await digestContent(bytes),
      protectedUntil: "2000-01-01T00:00:00.000Z",
    } as const;

    const deletedFirstHead = await acquiring.put(input);
    const [deleted, reacquired] = await Promise.all([
      maintaining.maintenance.delete({
        bodyId: input.bodyId,
        expectedState: "ready",
        expectedMaintenanceVersion: deletedFirstHead.maintenanceVersion,
        idleForMs: 0,
      }),
      acquiring.put(input),
    ]);
    assertEquals(
      reacquired.maintenanceVersion,
      deleted ? 1 : deletedFirstHead.maintenanceVersion + 1,
    );
    assertEquals(
      await readBodyBytes(maintaining, { bodyId: input.bodyId }),
      bytes,
    );

    const acquiredFirstHead = await acquiring.put(input);
    const [renewed, staleDelete] = await Promise.all([
      maintaining.put(input),
      acquiring.maintenance.delete({
        bodyId: input.bodyId,
        expectedState: "ready",
        expectedMaintenanceVersion: acquiredFirstHead.maintenanceVersion,
        idleForMs: 0,
      }),
    ]);
    assertEquals(
      renewed.maintenanceVersion,
      staleDelete ? 1 : acquiredFirstHead.maintenanceVersion + 1,
    );
    assertEquals(
      await readBodyBytes(acquiring, { bodyId: input.bodyId }),
      bytes,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

const createFaultPoints = [
  "create:data-synced",
  "create:manifest-staged",
  "create:manifest-published",
] as const;

const renewFaultPoints = [
  "renew:manifest-staged",
  "renew:manifest-published",
] as const;

const deleteFaultPoints = [
  "delete:tombstone-staged",
  "delete:tombstone-published",
  "delete:data-removed",
  "delete:tombstone-removed",
] as const;

async function filesystemFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for await (const entry of Deno.readDir(directory)) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory) await walk(path);
      else if (entry.isFile) files.push(path.slice(root.length + 1));
    }
  };
  await walk(root);
  return files.sort();
}

for (const point of createFaultPoints) {
  Deno.test(`Deno filesystem recovers a process stop at ${point}`, async () => {
    const root = await Deno.makeTempDir({
      prefix: "copilotz-assets-create-crash-",
    });
    try {
      let injected = false;
      const bytes = new TextEncoder().encode(`recover-${point}`);
      const input = {
        bodyId: "schemas/test/assets/create-crash",
        bytes,
        mediaType: "text/plain",
        digest: await digestContent(bytes),
        protectedUntil: "2000-01-01T00:00:00.000Z",
      } as const;
      const crashing = createFilesystemBodyStore({
        backendId: "filesystem:create-crash",
        protectionMs: 0,
        access: denoAssetFilesystemTesting.create(root, (actual) => {
          if (!injected && actual === point) {
            injected = true;
            throw new Error(`simulated process stop at ${point}`);
          }
        }),
      });
      await assertRejects(() => crashing.put(input));
      assertEquals(injected, true);

      const recovered = createFilesystemBodyStore({
        backendId: "filesystem:create-recovered",
        protectionMs: 0,
        access: denoAssetFilesystem(root),
      });
      if (point !== "create:manifest-published") {
        assertEquals(
          await recovered.maintenance.list({
            states: ["ready"],
            idleForMs: 0,
            limit: 10,
          }),
          { bodies: [] },
        );
      } else {
        assertEquals(
          (await recovered.head({ bodyId: input.bodyId }))?.maintenanceVersion,
          1,
        );
      }
      const acquired = await recovered.put(input);
      assertEquals(
        acquired.maintenanceVersion,
        point === "create:manifest-published" ? 2 : 1,
      );
      assertEquals(
        await readBodyBytes(recovered, { bodyId: input.bodyId }),
        bytes,
      );
      assertEquals((await filesystemFiles(root)).length, 2);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}

for (const point of renewFaultPoints) {
  Deno.test(`Deno filesystem preserves exact versions across ${point}`, async () => {
    const root = await Deno.makeTempDir({
      prefix: "copilotz-assets-renew-crash-",
    });
    try {
      const bytes = new TextEncoder().encode(`renew-${point}`);
      const input = {
        bodyId: "schemas/test/assets/renew-crash",
        bytes,
        mediaType: "text/plain",
        digest: await digestContent(bytes),
        protectedUntil: "2000-01-01T00:00:00.000Z",
      } as const;
      const initialStore = createFilesystemBodyStore({
        backendId: "filesystem:renew-initial",
        protectionMs: 0,
        access: denoAssetFilesystem(root),
      });
      const initial = await initialStore.put(input);
      let injected = false;
      const crashing = createFilesystemBodyStore({
        backendId: "filesystem:renew-crash",
        protectionMs: 0,
        access: denoAssetFilesystemTesting.create(root, (actual) => {
          if (!injected && actual === point) {
            injected = true;
            throw new Error(`simulated process stop at ${point}`);
          }
        }),
      });
      await assertRejects(() => crashing.put(input));
      assertEquals(injected, true);

      const recovered = createFilesystemBodyStore({
        backendId: "filesystem:renew-recovered",
        protectionMs: 0,
        access: denoAssetFilesystem(root),
      });
      const recoveredVersion = point === "renew:manifest-published" ? 2 : 1;
      assertEquals(
        (await recovered.head({ bodyId: input.bodyId }))?.maintenanceVersion,
        recoveredVersion,
      );
      if (point === "renew:manifest-published") {
        assertEquals(
          await recovered.maintenance.delete({
            bodyId: input.bodyId,
            expectedState: "ready",
            expectedMaintenanceVersion: initial.maintenanceVersion,
            idleForMs: 0,
          }),
          false,
        );
      }
      const renewed = await recovered.put(input);
      assertEquals(renewed.maintenanceVersion, recoveredVersion + 1);
      assertEquals((await filesystemFiles(root)).length, 2);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}

for (const point of deleteFaultPoints) {
  Deno.test(`Deno filesystem recovers a process stop at ${point}`, async () => {
    const root = await Deno.makeTempDir({
      prefix: "copilotz-assets-delete-crash-",
    });
    try {
      const bytes = new TextEncoder().encode(`delete-${point}`);
      const input = {
        bodyId: "schemas/test/assets/delete-crash",
        bytes,
        mediaType: "text/plain",
        digest: await digestContent(bytes),
        protectedUntil: "2000-01-01T00:00:00.000Z",
      } as const;
      const initialStore = createFilesystemBodyStore({
        backendId: "filesystem:delete-initial",
        protectionMs: 0,
        access: denoAssetFilesystem(root),
      });
      const initial = await initialStore.put(input);
      let injected = false;
      const crashing = createFilesystemBodyStore({
        backendId: "filesystem:delete-crash",
        protectionMs: 0,
        access: denoAssetFilesystemTesting.create(root, (actual) => {
          if (!injected && actual === point) {
            injected = true;
            throw new Error(`simulated process stop at ${point}`);
          }
        }),
      });
      await assertRejects(() =>
        crashing.maintenance.delete({
          bodyId: input.bodyId,
          expectedState: "ready",
          expectedMaintenanceVersion: initial.maintenanceVersion,
          idleForMs: 0,
        })
      );
      assertEquals(injected, true);

      const recovered = createFilesystemBodyStore({
        backendId: "filesystem:delete-recovered",
        protectionMs: 0,
        access: denoAssetFilesystem(root),
      });
      if (point === "delete:tombstone-staged") {
        assertEquals(
          (await recovered.head({ bodyId: input.bodyId }))?.maintenanceVersion,
          initial.maintenanceVersion,
        );
        assertEquals(
          await recovered.maintenance.delete({
            bodyId: input.bodyId,
            expectedState: "ready",
            expectedMaintenanceVersion: initial.maintenanceVersion,
            idleForMs: 0,
          }),
          true,
        );
      }
      assertEquals(await recovered.head({ bodyId: input.bodyId }), null);
      assertEquals(
        await recovered.maintenance.list({
          states: ["ready"],
          idleForMs: 0,
          limit: 10,
        }),
        { bodies: [] },
      );
      const recreated = await recovered.put(input);
      assertEquals(recreated.maintenanceVersion, 1);
      assertEquals(
        await readBodyBytes(recovered, { bodyId: input.bodyId }),
        bytes,
      );
      assertEquals((await filesystemFiles(root)).length, 2);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}
