import { assertEquals, assertRejects } from "@std/assert";
import type { OperationCatalog } from "../runtime/streams/catalog.ts";
import { watchSelection } from "./selection-watch.ts";

Deno.test("selection watch retries failed subscription acquisition", async () => {
  let attempts = 0;
  let removed = 0;
  const catalog = {
    onChange() {
      if (++attempts === 1) return Promise.reject(new Error("unavailable"));
      return Promise.resolve(() => removed++);
    },
  } as unknown as OperationCatalog;
  await assertRejects(
    () => watchSelection(catalog, "tenant", "thread", () => {}),
    Error,
    "unavailable",
  );
  const first = await watchSelection(catalog, "tenant", "thread", () => {});
  const second = await watchSelection(catalog, "tenant", "other", () => {});
  first.close();
  assertEquals(removed, 0);
  second.close();
  second.close();
  assertEquals(attempts, 2);
  assertEquals(removed, 1);
});

Deno.test("selection push reset rejects old observers and permits a fresh attachment", async () => {
  let send: Parameters<OperationCatalog["onChange"]>[0] | undefined;
  let subscriptions = 0;
  let removed = 0;
  const catalog = {
    onChange(listener: typeof send) {
      subscriptions++;
      send = listener;
      return Promise.resolve(() => removed++);
    },
    getSelectionHeads() {
      return Promise.resolve([]);
    },
    listSelectionChanges() {
      return Promise.resolve([]);
    },
  } as unknown as OperationCatalog;
  const first = await watchSelection(catalog, "scope", "selection", () => {});
  send!("", {
    namespace: "scope",
    selectionKeys: [],
    kind: "reset",
    headSeq: "2",
    reason: "owner_lost",
  });
  const error = await assertRejects(() => first.read("0"));
  assertEquals((error as { code?: string }).code, "observation_reset_required");
  first.close();
  const second = await watchSelection(catalog, "scope", "selection", () => {});
  assertEquals(await second.read("0"), []);
  second.close();
  assertEquals(subscriptions, 2);
  assertEquals(removed, 2);
});
