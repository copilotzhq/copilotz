# HTTP server and browser client

`createServerPlugin()` installs one compiled Fetch boundary at `/api`. Compose
it in the Gateway and Worker alongside the same Actions, Collections, Channels,
and application HTTP Adapters. The host serves `gateway.fetch`; the plugin does
not start a listener. Gateway and Worker share persistence and Asset storage.

```ts
import { createCopilotz } from "@copilotz/copilotz";
import { createServerPlugin } from "@copilotz/copilotz/server";
import { createCoreServerPlugin } from "@copilotz/copilotz/core/server";

const gateway = await createCopilotz({
  role: "gateway",
  ...infrastructure,
  plugins: [
    ...applicationPlugins,
    createCoreServerPlugin(),
    createServerPlugin({
      basePath: "/api",
      authenticate,
      authorize,
      expose: {
        actions: { include: publicActionIds },
        collections: { include: publicCollectionNames },
        channels: { include: ["web", "whatsapp"] },
      },
    }),
  ],
});
```

Authentication receives the matched endpoint and bounded lookup services. It
returns trusted actor, namespace, and database scope, or a Response.
Deliberately public OAuth and webhook endpoints declare their policy on exact
route descriptors. Authorization receives trusted scope and bounded read
services. Its Collection predicates are intersected with requested filters
before pagination, and its Action input constraints are enforced before durable
submission. Client IDs and cursors never confer authority. Without these
callbacks the facade exposes the selected primitives in the application's
default scope; use explicit policy for multi-user applications.

`createHttpAdapter({ routes })` contributes application-owned endpoints. Each
route declares method, path, schemas, and either an Action binding or a handler.
Handlers receive scoped reads, content, operation observation, and Action
submission/invocation services. Route collisions fail composition. The compiler
produces both the route table and OpenAPI; applications do not maintain a second
router or inventory.

## Canonical endpoints

All paths below are relative to `/api`.

| Capability                             | Method and path                                                 |
| -------------------------------------- | --------------------------------------------------------------- |
| Submit an Action                       | `POST /actions/myapp/stable/action-id`                          |
| Submit Channel input                   | `POST /channels/:alias`                                         |
| Operation status and result            | `GET /operations/:id`, `GET /operations/:id/result`             |
| Durable cancellation                   | `DELETE /operations/:id`                                        |
| Observe selected operations            | `POST /operations/observe`                                      |
| Core conversation reads                | `GET /threads`, `GET /threads/:id`, `GET /threads/:id/messages` |
| Core conversation observation          | `POST /threads/:id/observe`                                     |
| Collections, named queries, and Assets | Compiled under `/collections` and `/assets`                     |
| Route specification                    | `GET /openapi.json`                                             |

Action IDs retain their stable identity; dots become path separators. Core
mutations are ordinary Actions with IDs under `copilotz.core.conversation`.
There are no versioned aliases, override paths, compatibility transports, or
catch-all Adapter dispatchers.

Action and request-observed Channel submissions return **202 operation
receipts**. Every submission has a stable `Idempotency-Key`: identical retries
recover the same operation, and conflicting input returns 409. Provider
acknowledgements, reads, raw uploads, and OAuth responses retain their
appropriate status codes. Asset uploads default to 20 MiB; `maxAssetUploadBytes`
can lower that bound. `Content-Type` supplies media type and
`Content-Disposition` supplies filename.

## Browser usage

```ts
import { createCopilotzClient } from "@copilotz/copilotz/client";
import { createCoreClient } from "@copilotz/copilotz/core/client";

const client = createCopilotzClient({ baseUrl: "/api", getRequestHeaders });
const core = createCoreClient(client);
const receipt = await core.threads.send({
  externalThreadId: crypto.randomUUID(),
  content: "Hello",
  recipientIds: ["support"],
}, { idempotencyKey: crypto.randomUUID() });
const result = await client.operations.result(receipt.operationId);
```

Use `threadId` for an existing canonical conversation and `externalThreadId` for
a new one. The authenticated server supplies the sender. `client.actions.invoke`
uses the same submit, settlement, and result path as `submit`; it adds no
executor. Generic inputs/results remain schema-validated values, while Core
reads and conversation inputs have concrete types. Both client exports are
browser-safe.

Observation uses Fetch-streamed multipart: canonical output descriptors, raw
progressive bytes, terminal stream outcomes, operation lifecycle outputs, and
heartbeat/control frames. Selections and checkpoints are JSON request bodies.
The client awaits `onFrame` before advancing its checkpoint. Retry resumes only
successfully applied frames. Aborting observation detaches the connection; only
the explicit operation cancellation endpoint stops durable work.

A result waits for its own Action's streams; operation completion waits for all
remaining streams. Observation bounds are 32 operations and 256 streams, with
explicit capacity errors requiring a fresh history bootstrap. Core captures a
conservative durable boundary before history, discovers overlapping operations,
and replays them using canonical identities. No stream is treated as consumed
merely because an operation has settled.

Secret-marked inputs are encrypted before the existing durable Action ingress.
Observations retain redacted values. Authorized result reads hydrate protected
results and use `Cache-Control: no-store`; generated OpenAPI removes examples
and defaults from secret-marked schema nodes. HTTP adds no storage format,
database migration, output log, or execution lifecycle.

### Conversation membership and recipients

`core.threads.send` accepts `participantIds` for the agents enrolled in a
conversation and `recipientIds` for the agents addressed by this message. For
example, `participantIds: ["north", "west"]` and `recipientIds: ["north"]` allow
North to ask West without asking both agents to answer the user message.
Membership selections resolve only to registered agents in the authenticated
scope. Existing authorized threads enroll missing selections before delivery;
this neither removes existing participants nor rewrites conversation history.

### Message content access

Use `core.messages.asset(threadId, messageId, assetId, { signal })` to read a
conversation Asset. It returns the raw Fetch Response from
`GET /api/threads/:id/messages/:messageId/assets/:assetId`. Core checks the
authorized thread, message visibility, and the exact reference in canonical
message content or reasoning before reading bytes in the authenticated scope.
History filters participant-private messages before pagination. Internal and
private history-scope messages are not exposed through this boundary.

Content becomes readable as soon as the authorized message exists; it does not
depend on an asynchronous access projection. A bare Asset identifier conveys no
message authority. Applications retain their own policy for generic Asset reads.
Existing Asset bytes, message records, and retained revisions are reused without
a migration.
