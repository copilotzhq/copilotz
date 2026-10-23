import { createApplication } from "@oxian/oxian-js/app";
import {
  createTestApplication,
  defineTestServerFacade,
} from "../../../runtime/testing/server-authorization.test.ts";
import { createTestDatabase } from "../../../runtime/testing/ominipg.ts";
import { defineCollection } from "../../../runtime/collections/definition.ts";
import { createServerFacadeFetchHandler } from "../../../server/facade.ts";

type State = { handler(request: Request): Promise<Response> };
export default async function factory(
  context: import("@oxian/oxian-js/app").ApplicationFactoryContext<State>,
) {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const app = await createTestApplication({
    database: db,
    databaseSchema: Deno.env.get("SEC3_CLI_SCHEMA")!,
    namespace: "main",
    collections: {
      note: defineCollection({
        name: "note",
        schema: { type: "object", properties: { id: { type: "string" } } },
      }),
    },
    resources: {
      server: {
        default: defineTestServerFacade({
          expose: { collections: true },
          authenticate(request) {
            return request.headers.get("authorization") === "Bearer cli"
              ? {}
              : new Response(null, { status: 403 });
          },
        }),
      },
    },
  });
  await app.collections.withScope({ namespace: "main" }).note.create({
    id: "cli-snapshot",
  });
  return createApplication({
    router: context.router,
    basePath: context.basePath,
    state: { handler: createServerFacadeFetchHandler(app) },
    async dispose() {
      await app.close();
      await db.close();
      console.log("SEC3 CLI database closed");
    },
  });
}
