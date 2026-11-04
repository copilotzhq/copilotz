/**
 * What an operation's tool takes: one input object, its parameters and its
 * JSON body side by side, as JSON Schema (refs followed, 3.0's dialect
 * converted, what a request doesn't send left out); and what fails.
 */
import { assertEquals, assertThrows } from "@std/assert";
import { openapi } from "../mod.ts";
import { convert } from "../shared/schema.ts";
import { test } from "../../../../testing/mod.ts";
import spec from "./trips.json" with { type: "json" };

const trips = openapi({ name: "trips", spec });
const inputOf = (operation: string) => trips.tools[operation].input as Record<string, unknown>;

/** A one-operation spec: `POST /things/{id}` with these parameters and body. */
const one = (operation: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  openapi: "3.1.0",
  servers: [{ url: "https://things.test" }],
  paths: { "/things/{id}": { post: { operationId: "make", ...operation } } },
  ...extra,
});

test("an operation's input has its parameters and its body's properties, side by side", () => {
  assertEquals(inputOf("createTrip"), {
    type: "object",
    properties: {
      "Idempotency-Key": { type: "string" },
      name: { type: "string", description: "What it's called." },
      notes: { type: ["string", "null"] },
      budget: { type: "number", format: "double" },
      kind: { type: ["string", "null"], enum: ["work", "leisure", null] },
      destination: {
        type: "object",
        description: "Somewhere, inside somewhere bigger.",
        properties: {
          name: { type: "string" },
          // It contains itself: inside, anything of its type.
          within: { type: "object", description: "Somewhere, inside somewhere bigger." },
        },
      },
      legs: {
        type: "array",
        items: {
          type: "object",
          required: ["from", "to"],
          properties: {
            from: {
              type: "object",
              description: "Somewhere, inside somewhere bigger.",
              properties: {
                name: { type: "string" },
                within: { type: "object", description: "Somewhere, inside somewhere bigger." },
              },
            },
            to: {
              type: "object",
              description: "Somewhere, inside somewhere bigger.",
              properties: {
                name: { type: "string" },
                within: { type: "object", description: "Somewhere, inside somewhere bigger." },
              },
            },
          },
        },
      },
    },
    // `id` is read-only: the API makes it, so it isn't asked for, required or not.
    required: ["name"],
  });
});

test("query, header and cookie parameters keep their enums, defaults, formats and words", () => {
  assertEquals(inputOf("listTrips"), {
    type: "object",
    properties: {
      status: { type: "string", enum: ["planned", "done"], default: "planned" },
      tag: {
        type: "array",
        items: { type: "string" },
        description: "Only trips with all of these tags.",
      },
      ids: { type: "array", items: { type: "string" } },
      near: { type: "object", properties: { lat: { type: "number" }, lng: { type: "number" } } },
      // 3.0's boolean exclusiveMinimum, and its example, as JSON Schema has them.
      limit: { type: "integer", exclusiveMinimum: 0, maximum: 100, examples: [20] },
      "X-Request-Id": { type: "string", format: "uuid" },
      // An Authorization header isn't a parameter: the settings send it.
      session: { type: "string" },
    },
  });
  // A path's parameters (a $ref) are every operation's under it, and required.
  assertEquals(inputOf("getTrip"), {
    type: "object",
    properties: { tripId: { type: "string", description: "The trip's id." } },
    required: ["tripId"],
  });
});

test("a body that isn't an object is `body`; ids are cleaned, or made from the method and path", () => {
  assertEquals(inputOf("set_tags").properties, {
    tripId: { type: "string", description: "The trip's id." },
    body: { type: "array", items: { type: "string" }, description: "The tags." },
  });
  assertEquals(inputOf("set_tags").required, ["tripId", "body"]);
  assertEquals(trips.operations.get_trips_tripId_photo, {
    tool: "trips_get_trips_tripId_photo",
    action: "trips.get_trips_tripId_photo",
    method: "GET",
    path: "/trips/{tripId}/photo",
  });
  // An upload's body isn't JSON: left out, saying why.
  assertEquals(trips.skipped, { uploadReceipt: "its body isn't JSON (multipart/form-data)" });
  assertEquals(Object.keys(trips.resources!.tools), [
    "trips_listTrips",
    "trips_createTrip",
    "trips_getTrip",
    "trips_cancelTrip",
    "trips_set_tags",
    "trips_getMap",
    "trips_get_trips_tripId_photo",
  ]);
  assertEquals(Object.keys(trips.actions!)[0], "trips.listTrips");
});

test("a tool's description is its summary and description; it says one that repeats once", () => {
  assertEquals(trips.tools.listTrips.description, "List trips\n\nTrips, newest first.");
  assertEquals(trips.tools.getTrip.description, "Get a trip, with its legs.");
  assertEquals(trips.tools.cancelTrip.description, "Cancel a trip");
  const bare = openapi({ name: "x", spec: one({ operationId: undefined }) });
  assertEquals(bare.tools.post_things_id.description, "POST /things/{id}");
});

test("two inputs of one name fail: a path parameter and a body property", () => {
  const clash = one({
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    requestBody: {
      content: {
        "application/json": { schema: { type: "object", properties: { id: { type: "string" } } } },
      },
    },
  });
  assertThrows(
    () => openapi({ name: "x", spec: clash }),
    Error,
    'operation "make" (POST /things/{id}) has two inputs named "id" (path parameter and body ' +
      "property)",
  );
  // A query parameter and a header of one name, too.
  const twice = one({
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string" } },
      { name: "v", in: "query", schema: { type: "string" } },
      { name: "v", in: "header", schema: { type: "string" } },
    ],
  });
  assertThrows(() => openapi({ name: "x", spec: twice }), Error, "query parameter and header");
  // Leaving it out is the way round it.
  const other = one({}, { paths: { ...clash.paths, "/ok": { get: { operationId: "ok" } } } });
  assertEquals(Object.keys(openapi({ name: "x", spec: other, operations: ["ok"] }).tools), ["ok"]);
});

test("GET's body is no input; an object body made of allOf parts is flattened", () => {
  const spec: { paths: Record<string, Record<string, unknown>> } & Record<string, unknown> = {
    openapi: "3.1.0",
    servers: [{ url: "https://things.test" }],
    paths: {
      "/a": {
        get: {
          operationId: "read",
          requestBody: { content: { "application/json": { schema: { type: "object" } } } },
        },
        post: {
          operationId: "write",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/Base" },
                    { type: "object", properties: { b: { type: "integer" } }, required: ["b"] },
                  ],
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: { Base: { type: "object", properties: { a: { type: "string" } } } },
    },
  };
  // A body of any type (as some generators write a JSON one) is taken as JSON.
  const any = { content: { "*/*": { schema: { type: "object", properties: { c: {} } } } } };
  spec.paths["/a"] = { ...spec.paths["/a"], put: { operationId: "put", requestBody: any } };
  const api = openapi({ name: "x", spec });
  assertEquals(api.tools.put.input, { type: "object", properties: { c: {} } });
  assertEquals(api.tools.read.input, { type: "object", properties: {} });
  assertEquals(api.tools.write.input, {
    type: "object",
    properties: { a: { type: "string" }, b: { type: "integer" } },
    required: ["b"],
  });
});

test("3.0's nullable: null as well, for a type, an enum, or a schema of no type", () => {
  const doc = { openapi: "3.0.3" };
  assertEquals(convert(doc, { type: "integer", nullable: true }), { type: ["integer", "null"] });
  assertEquals(convert(doc, { type: "string", enum: ["a"], nullable: true }), {
    type: ["string", "null"],
    enum: ["a", null],
  });
  assertEquals(convert(doc, { allOf: [{ type: "string" }], nullable: true }), {
    anyOf: [{ allOf: [{ type: "string" }] }, { type: "null" }],
  });
  // What isn't JSON Schema goes; a 3.1 type list stays as it is.
  assertEquals(
    convert(doc, {
      type: ["string", "null"],
      discriminator: {},
      xml: {},
      "x-a": 1,
      deprecated: true,
    }),
    { type: ["string", "null"], deprecated: true },
  );
});

test("$refs: a sibling keyword wins, a missing or remote one fails, a recursive one is kept open", () => {
  const doc = {
    openapi: "3.1.0",
    components: {
      schemas: {
        Name: { type: "string", description: "A name." },
        Node: { type: "object", properties: { next: { $ref: "#/components/schemas/Node" } } },
        "a/b": { type: "boolean" },
      },
    },
  };
  assertEquals(convert(doc, { $ref: "#/components/schemas/Name", description: "Its name." }), {
    type: "string",
    description: "Its name.",
  });
  assertEquals(convert(doc, { $ref: "#/components/schemas/a~1b" }), { type: "boolean" });
  assertEquals(convert(doc, { $ref: "#/components/schemas/Node" }), {
    type: "object",
    properties: { next: { type: "object" } },
  });
  assertThrows(() => convert(doc, { $ref: "#/components/schemas/None" }), Error, "Nothing at");
  assertThrows(() => convert(doc, { $ref: "other.json#/A" }), Error, "Only local $refs");
});

test("a spec that isn't OpenAPI 3, or names it can't take, fail as it's made", () => {
  assertThrows(() => openapi({ name: "x", spec: { swagger: "2.0" } }), Error, "Swagger 2.0");
  assertThrows(() => openapi({ name: "x", spec: "openapi: 3.1.0" }), Error, "parse YAML first");
  assertThrows(() => openapi({ name: "a.b", spec }), Error, "letters, digits");
  assertThrows(
    () => openapi({ name: "x", spec, operations: ["nope"] }),
    Error,
    'no operation "nope"',
  );
  assertThrows(
    () => openapi({ name: "x", spec, operations: ["uploadReceipt"] }),
    Error,
    "can't be a tool: its body isn't JSON",
  );
  // JSON text is a spec too.
  assertEquals(
    Object.keys(openapi({ name: "x", spec: JSON.stringify(spec), operations: ["getTrip"] }).tools),
    ["getTrip"],
  );
});
