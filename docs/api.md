# API and Package Reference

## Application roles

### `createCopilotz(options?)`

The normal embedded factory. It creates one private Gateway and Worker over an
in-process Oxian event fabric and opens a private Ominipg database unless a
database is injected. Its result exposes Copilotz domain/application semantics,
not the private Hypervisor, transport, engine, or Worker workload closures.

Main options:

- `namespace`, `databaseSchema`
- `database`: Ominipg configuration or an existing Ominipg-compatible instance
- `core: false | CopilotzCorePluginOptions`
- `plugins`, `resources`, `pluginResolver`
- `toolCatalog` shared by execution and capability introspection
- `worker: { id?, capacity? }`

Configuration-created databases are closed by the application. Injected database
instances are never closed by Copilotz.

### `createCopilotzGateway(options?, lifecycle?)`

Creates durable ingress, event/output relay, recovery APIs, plugin/resource
introspection, and the runtime-neutral HTTP boundary. It hosts no plugin work.

Pass either:

- `transports`, which makes the Gateway own its Oxian Hypervisor; or
- `dispatcher`, which remains owned by the embedding application.

`target` and `workloadTargets` declare placement without exposing Worker
closures. The optional second argument receives Oxian Hypervisor lifecycle
callbacks such as `onWorkAccepted`.

The result has `fetch(request)`, and a Gateway-owned `hypervisor` is present
only when Copilotz created it. Deno can listen with:

```ts
import { listen } from "@copilotz/copilotz/adapters/deno";

const listener = listen(gateway, { hostname: "0.0.0.0", port: 8080 });
```

Other runtimes mount `gateway.fetch` in their native server boundary.

### `createCopilotzWorker(options, lifecycle?)`

Creates an outbound Worker that reconstructs plugin executors locally and
registers only Copilotz workloads with Oxian. Required topology fields are the
plain Worker primitives: `id` and `transport`. WebSocket deployments also pass
`activate`, `register`, and `handshake`; the optional second argument observes
the Worker lifecycle.

The result exposes `ready`, `closed`, `events`, `snapshot()`, and `stop()`. It
does not expose the internal application used to host workload closures.

## Shared role configuration

Gateway and Worker should receive equivalent domain composition and reachable
persistence. Ordinary object spread keeps that relationship visible:

```ts
const composition = {
  namespace: "acme",
  database,
  plugins,
};
const transport = {
  type: "in-process",
  config: { topic: "acme.copilotz" },
} as const;
const workerId = "acme-worker";

const gateway = await createCopilotzGateway({
  ...composition,
  transports: [transport],
  target: { workerId },
});
const worker = await createCopilotzWorker({
  ...composition,
  id: workerId,
  transport,
});
await worker.ready;
```

No opaque composition factory is required.

## `CopilotzApplication`

Important members:

- `config`, `plugins`, `capabilities`
- `content`, `conversation`, `collections`, `relations`
- `llmAttempts`, `toolExecutions`, `schedules`, `knowledge`
- `events`, `deliveries`
- `databaseSchema`, `databaseScope(name)`
- `run(input)`, `connect(input)`, `goal(input)`
- `recover(options)`, `maintenance(options)`, `shutdown(reason?)`

All products are factory-created frozen records. Infer their type or import
`CopilotzApplication`; do not subclass them.

`application.capabilities.resolve({ agent })` returns the agent's effective
tool, peer-agent, and skill resources with plugin origins and grant sources.
Omitted grants resolve to none.

`databaseScope(name)` returns a lightweight physical-schema-bound view of the
domain repositories, events, deliveries, attachments, and maintenance APIs.
Scopes share the application's Ominipg database and Oxian execution runtime. For
`run()`, `connect()`, and `goal()`, `databaseSchema` can select the same scope
directly.

## Run handle

```ts
type RunHandle = {
  eventId: string;
  threadId: string;
  correlationId: string;
  events: ReadableStream<CopilotzEvent>;
  done: Promise<void>;
  cancel(reason?: string): Promise<void>;
};
```

## Attachment

```ts
type ThreadAttachment = {
  id: string;
  namespace: string;
  thread: ConversationThread;
  participant: Participant;
  outputs: ReadableStream<AttachmentOutput>;
  send(input): Promise<AttachmentSendResult>;
  close(reason?: string): Promise<void>;
};
```

## Skills

`@copilotz/copilotz/skills` exports `defineSkill()`, `defineInlineSkill()`,
`createSkillsPlugin()`, strict `SKILL.md` parsing, and portable skill/file
types. `@copilotz/copilotz/adapters/deno` exports `buildOpenSkillsPlugin()` for
build-time conversion of standard Agent Skills directories into a portable
plugin. Filesystem directory loading is not an application runtime API.

## HTTP and v1 compatibility

`gateway.fetch` is the v3 Web Fetch API. It serves the Copilotz application at
`/v3` by default and also handles Worker upgrades when the Gateway owns a
WebSocket transport.

`resolveDatabaseSchema(request)` on `createCopilotzGateway()` is the explicit
tenant-authorization boundary for multi-schema HTTP routing. Request context
cannot override the resolver. Feature actions may return `headers` alongside
`status` and `data`; the Fetch adapter preserves those headers for JSON, 204,
and SSE responses.

`@copilotz/copilotz/server` contains only the transitional v1 projection:

- `createV1FetchHandler(application, options?)`
- `createV1SseProjector(application, options?)`

The v1 SSE projection writes the projected frame `type` as the SSE `event:`
name. Thread records preserve `name` and `description`; message history accepts
`before`, `after`, `order`, and `limit` query parameters.

## Package exports

The authoritative subpath list is `deno.json`. Public groups are application,
capabilities, plugins, resources, content, domain, events, attachments,
workflows, memory, knowledge, schedules, usage, skills, tools, channels,
features, admin, goals, adapters, the transitional server projection, and the
isolated v1 migration.

Internal engine assembly, delivery executors, framed Worker protocol, and raw
workload maps are implementation details rather than package entry points. Every
declared subpath is checked independently in CI.
