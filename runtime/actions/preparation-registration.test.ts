import { assertEquals, assertThrows } from "@std/assert";
import {
  type ActionPreparations,
  captureActionPreparationOptions,
  captureActionPreparations,
} from "./preparation.ts";
const definition = () => ({
  registrations: {
    note: {
      source: "notes",
      actionAlias: "child",
      shows: { list: "notes" },
      modes: ["context"],
      resources: [{ namespace: "core", alias: "style" }],
      mapInput: (text: string) => ({ text }),
    },
  },
  source: {
    sources: { notes: { collectionAlias: "notes", fields: ["/title"] } },
    authorize: () => ({ namespace: "scope", audience: "member" }),
    projectRecord: (record: Readonly<Record<string, unknown>>) => record,
    authorizeOriginal: () => true,
  },
  projectResource: () => null,
  authorizeResource: () => true,
  authorizeView: () => true,
} satisfies ActionPreparations);
Deno.test("named registration captures immutable nested descriptors before asynchronous initialization", () => {
  const original = definition();
  const captured = captureActionPreparations(original);
  original.registrations.note.source = "other";
  original.registrations.note.modes.push("other");
  original.registrations.note.shows.list = "other";
  original.registrations.note.resources[0].alias = "other";
  original.source.sources.notes.fields[0] = "/other";
  assertEquals(captured.registrations.note.source, "notes");
  assertEquals(captured.registrations.note.modes, ["context"]);
  assertEquals(captured.registrations.note.shows, { list: "notes" });
  assertEquals(captured.registrations.note.resources, [{
    namespace: "core",
    alias: "style",
  }]);
  assertEquals(captured.source.sources.notes.fields, ["/title"]);
  assertThrows(() => {
    (captured.registrations.note.modes as string[]).push("mutated");
  });
});
Deno.test("named registration rejects nested getters and constructor accessors without evaluation", () => {
  let reads = 0;
  const getter = {
    enumerable: true,
    get() {
      reads++;
      return "other";
    },
  };
  for (
    const mutate of [
      (value: ReturnType<typeof definition>) =>
        Object.defineProperty(value.registrations.note, "source", getter),
      (value: ReturnType<typeof definition>) =>
        Object.defineProperty(value.registrations.note.shows, "list", getter),
      (value: ReturnType<typeof definition>) =>
        Object.defineProperty(value.source.sources.notes, "fields", getter),
      (value: ReturnType<typeof definition>) =>
        Object.defineProperty(value, "authorizeView", getter),
    ]
  ) {
    const original = definition();
    mutate(original);
    assertThrows(() => captureActionPreparations(original));
  }
  assertThrows(() =>
    captureActionPreparationOptions(Object.defineProperty({}, "engine", getter))
  );
  assertThrows(() =>
    captureActionPreparationOptions({
      engine: Object.defineProperty({}, "preparations", getter),
    })
  );
  assertEquals(reads, 0);
});
