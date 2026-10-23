import { assertEquals } from "@std/assert";
import { localStorageAdapter } from "./storage.ts";

Deno.test("local storage adapter treats corrupted values as nothing stored", () => {
  const values = new Map<string, string>([["copilotz:prefs", "{not json"]]);
  const adapter = localStorageAdapter({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  });
  assertEquals(adapter.load("prefs"), undefined);
});

Deno.test("local storage adapter keeps running when storage throws", () => {
  const adapter = localStorageAdapter({
    getItem: () => {
      throw new DOMException("blocked", "SecurityError");
    },
    setItem: () => {
      throw new DOMException("full", "QuotaExceededError");
    },
  });
  assertEquals(adapter.load("prefs"), undefined);
  adapter.save("prefs", [{ id: "a" }]);
});

Deno.test("local storage adapter round-trips stored values", () => {
  const values = new Map<string, string>();
  const adapter = localStorageAdapter({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  }, "app:");
  adapter.save("prefs", [{ id: "a" }]);
  assertEquals(adapter.load("prefs"), [{ id: "a" }]);
  assertEquals([...values.keys()], ["app:prefs"]);
});
