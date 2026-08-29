import { assert, assertEquals, assertThrows } from "@std/assert";
import { defineAction } from "@copilotz/copilotz/actions";
import { defineCollection } from "@copilotz/copilotz/collections";
import { createPluginRegistry, definePlugin } from "@copilotz/copilotz/plugins";
import { defineServerFacade } from "../../resources/facade/index.ts";
import { compileServerRoutes } from "./index.ts";

const notes = defineCollection({
  name: "notes",
  schema: {
    type: "object",
    properties: { id: { type: "string" }, label: { type: "string" } },
    required: ["label"],
  } as const,
  queries: {
    byLabel: {
      inputSchema: {
        type: "object",
        properties: { label: { type: "string" } },
        required: ["label"],
      },
      filter: ({ input }) => ({ label: input.label }),
    },
  },
  commands: {
    rename: {
      input: { type: "object", properties: { label: { type: "string" } } },
      mutate: ({ input }) => ({ set: input as Record<string, unknown> }),
    },
  },
});

const preview = defineAction({
  id: "compass.sandbox.preview.list",
  inputSchema: { type: "object" } as const,
  execute: () => ({ ok: true }),
});

const fixture = definePlugin({
  id: "test.server-routes",
  version: "1.0.0",
  actions: { preview },
  collections: { noteStore: notes },
  resources: { channels: { web: Object.freeze({ id: "web" }) } },
  adapters: { channels: { web: Object.freeze({ accept() {} }) } },
});

const SECRET_DISCLOSURE_KEYWORDS = [
  "default",
  "const",
  "enum",
  "examples",
  "example",
] as const;

function secretSchema(value: string) {
  return {
    type: "string",
    description: "A secret value.",
    "x-copilotz-secret": true,
    default: `${value}-default`,
    const: `${value}-const`,
    enum: [`${value}-enum`],
    examples: [`${value}-examples`],
    example: `${value}-example`,
  } as const;
}

function assertSecretProjection(schema: Record<string, unknown>): void {
  assertEquals(schema["x-copilotz-secret"], true);
  for (const keyword of SECRET_DISCLOSURE_KEYWORDS) {
    assertEquals(keyword in schema, false, `${keyword} must be omitted`);
  }
  assertEquals(schema.description, "A secret value.");
}

Deno.test("route compiler maps IDs, queries, commands, overrides, and OpenAPI", () => {
  const routes = compileServerRoutes(
    createPluginRegistry({ plugins: [fixture] }),
    defineServerFacade({
      overrides: {
        actions: {
          "compass.sandbox.preview.list": { path: "/features/previews/list" },
        },
      },
    }),
  );
  assertEquals(
    routes.match("POST", "/api/v1/features/previews/list")?.endpoint.id,
    "compass.sandbox.preview.list",
  );
  assertEquals(
    routes.match("QUERY", "/api/v1/collections/notes/queries/byLabel")
      ?.endpoint.operation,
    "query:byLabel",
  );
  assertEquals(
    routes.match("POST", "/api/v1/collections/notes/n-1/commands/rename")
      ?.params.id,
    "n-1",
  );
  const paths = routes.openApi.paths as Record<string, Record<string, unknown>>;
  assertEquals(
    paths["/api/v1/collections/notes/queries/byLabel"].query !== undefined,
    true,
  );
  const created = paths["/api/v1/collections/notes"].post as Record<
    string,
    unknown
  >;
  assertEquals(Object.keys(created.responses as Record<string, unknown>), [
    "201",
  ]);
  const deleted = paths["/api/v1/collections/notes/{id}"].delete as Record<
    string,
    unknown
  >;
  assertEquals(Object.keys(deleted.responses as Record<string, unknown>), [
    "204",
  ]);
  assertEquals(deleted.parameters, [{
    name: "id",
    in: "path",
    required: true,
    schema: { type: "string" },
  }]);
  const listed = paths["/api/v1/collections/notes"].get as Record<
    string,
    unknown
  >;
  const listSchema =
    (((listed.responses as Record<string, unknown>)["200"] as Record<
      string,
      unknown
    >).content as Record<string, Record<string, unknown>>)[
      "application/json"
    ].schema as Record<string, unknown>;
  assertEquals(
    ((listSchema.properties as Record<string, unknown>).data as Record<
      string,
      unknown
    >).type,
    "array",
  );
  assertEquals(Object.isFrozen(routes.openApi), true);
  assertEquals(Object.isFrozen(paths), true);
  assertEquals(Object.isFrozen(listSchema), true);
});

Deno.test("route compiler exposes the generic binary asset upload contract", () => {
  const routes = compileServerRoutes(
    createPluginRegistry({ plugins: [fixture] }),
    defineServerFacade(),
  );
  const upload = routes.match("POST", "/api/v1/assets");
  assertEquals(upload?.endpoint, {
    key: "POST:/assets",
    kind: "asset",
    id: "assets",
    method: "POST",
    path: "/assets",
    operation: "upload",
  });
  assertEquals(
    routes.match("GET", "/api/v1/assets/a-1")?.endpoint.kind,
    "asset",
  );
  const paths = routes.openApi.paths as Record<string, Record<string, unknown>>;
  const operation = paths["/api/v1/assets"].post as Record<string, unknown>;
  assertEquals(operation.operationId, "assets.upload");
  assertEquals(
    ((operation.requestBody as Record<string, Record<string, unknown>>).content[
      "application/octet-stream"
    ] as Record<string, unknown>).schema,
    { type: "string", format: "binary" },
  );
  assertEquals(Object.keys(operation.responses as Record<string, unknown>), [
    "201",
  ]);
});

Deno.test("route compiler applies glob exclusion and rejects bad overrides", () => {
  const registry = createPluginRegistry({ plugins: [fixture] });
  const routes = compileServerRoutes(
    registry,
    defineServerFacade({ expose: { actions: { exclude: ["compass.*"] } } }),
  );
  assertEquals(
    routes.match("POST", "/api/v1/actions/compass/sandbox/preview/list"),
    null,
  );
  assertThrows(
    () =>
      compileServerRoutes(
        registry,
        defineServerFacade({
          overrides: { actions: { "missing.action": { path: "/missing" } } },
        }),
      ),
    TypeError,
    "was not found",
  );
});

Deno.test("route compiler redacts secret disclosures from the OpenAPI projection", () => {
  const schema = {
    type: "object",
    properties: {
      nested: {
        type: "object",
        properties: { password: secretSchema("nested") },
      },
      tokens: { type: "array", items: secretSchema("array") },
      choice: {
        oneOf: [secretSchema("union"), { type: "string", default: "public" }],
      },
      credential: { $ref: "#/$defs/credential" },
    },
    $defs: {
      credential: {
        type: "object",
        properties: { token: secretSchema("reference") },
      },
    },
  } as const;
  const protectedAction = defineAction({
    id: "test.openapi-secrets",
    inputSchema: schema,
    outputSchema: schema,
    execute: () => ({}),
  });
  const routes = compileServerRoutes(
    createPluginRegistry({
      plugins: [definePlugin({
        id: "test.openapi-secrets",
        version: "1.0.0",
        actions: { protectedAction },
      })],
    }),
    defineServerFacade(),
  );
  const path = routes.openApi.paths as Record<string, Record<string, unknown>>;
  const operation = path["/api/v1/actions/test/openapi-secrets"].post as Record<
    string,
    unknown
  >;
  const requestSchema = (
    (operation.requestBody as Record<string, unknown>).content as Record<
      string,
      Record<string, Record<string, unknown>>
    >
  )["application/json"].schema;
  const responseSchema = (
    (
      (operation.responses as Record<string, Record<string, unknown>>)["200"]
        .content as Record<string, Record<string, Record<string, unknown>>>
    )["application/json"].schema.properties as Record<
      string,
      Record<string, unknown>
    >
  ).data;

  const assertProjectedSchema = (value: Record<string, unknown>) => {
    const properties = value.properties as Record<
      string,
      Record<string, unknown>
    >;
    assertSecretProjection(
      (properties.nested.properties as Record<string, Record<string, unknown>>)
        .password,
    );
    assertSecretProjection(properties.tokens.items as Record<string, unknown>);
    assertSecretProjection(
      (properties.choice.oneOf as readonly Record<string, unknown>[])[0],
    );
    const definitions = value.$defs as Record<string, Record<string, unknown>>;
    assertSecretProjection(
      (definitions.credential.properties as Record<
        string,
        Record<string, unknown>
      >)
        .token,
    );
  };
  assertProjectedSchema(requestSchema);
  assertProjectedSchema(responseSchema);

  const rawPassword = (
    (protectedAction.inputSchema!.properties as Record<
      string,
      Record<string, unknown>
    >)
      .nested.properties as Record<string, Record<string, unknown>>
  ).password;
  assert(SECRET_DISCLOSURE_KEYWORDS.every((keyword) => keyword in rawPassword));
  const route = routes.match("POST", "/api/v1/actions/test/openapi-secrets");
  const routePassword = (
    (route!.endpoint.inputSchema!.properties as Record<
      string,
      Record<string, unknown>
    >)
      .nested.properties as Record<string, Record<string, unknown>>
  ).password;
  assert(
    SECRET_DISCLOSURE_KEYWORDS.every((keyword) => keyword in routePassword),
  );
});
