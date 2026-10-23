---
title: "Upgrading and Data Safety"
description: "Pin Copilotz versions, keep durable identities stable, evolve record schemas deliberately, and run explicit offline database upgrades without losing history."
section: Evolve
order: 20
status: stable
---

# Upgrading and Data Safety

## Upgrading to 0.90.0

0.90.0 refuses several configurations and requests that 0.89.0 accepted. The
first part of this checklist applies to every application. The second covers
surfaces that are new in 0.90.0: the device socket and live reads, Action
sessions and flows, the web runtime and chat UI, and the shard role. Read it if
you adopt them, or if you built on a pre-release. The
[CHANGELOG](../CHANGELOG.md) lists everything else that changed.

### Every application

#### Action completion and scope settlement

`ActionHandle.result()` now resolves as soon as the invoked Action's durable
result exists. `status` becomes `completed` then, even while inherited
deliveries or streams are pending. A failed Action still rejects. A downstream
dead letter cannot reject a successful result retroactively.

Use `await handle.settled()` before work that requires downstream projections or
all inherited deliveries to succeed. It returns the Action value on success and
rejects failed/cancelled settlement. SDK callers use
`await client.operations.settled(operationId)` and inspect its `outcome`; the
response also includes the final owner `seq`. Live reads must still apply
through that sequence before their projection is current. Browser-local wrappers
must explicitly await their child server handle's `settled()` when needed.
Custom `ActionTransport` implementations resolve `invoke()` at Action completion
and implement `settled(operationId, signal)` for the scope wait; without it,
`handle.settled()` rejects as unsupported.

The final observe descriptor changes from `operation.completed`,
`operation.failed` and `operation.cancelled` to `operation.settled` with
`state: "settled"` and `outcome: "completed" | "failed" | "cancelled"`. Do not
retire observation on an Action's `*.completed` or `*.failed` event; those
durable lifecycle outputs arrive before scope settlement. HTTP operation status
uses `state: "settled"`, `outcome` and `settledAt`. Checkpoint/resume and
retirement boundaries are unchanged. Submission receipt `status` also uses
`settled` for a finished scope; retrieve its outcome separately rather than
interpreting that receipt as an Action result.

`GET /operations/:id/result`, SDK `actions.invoke`, and host `app.actions.*`
return the invoked Action result without waiting for the whole scope.
`awaitOperation`, `app.send().done` and `app.attach().done` still wait for scope
settlement. The retained catalog's state/timestamp representation is unchanged,
so the migration API requires no new schema step. An early Action result is not
a safe drain barrier for an offline migration.

Core chat deliberately keeps `createThread(...).result()` before sending the
first message: the thread is committed by that Action. Core/UI callers that use
returned IDs, direct mutations or live subscriptions need no settlement wait.

#### Database

1. **Upgrade every owner schema from v13 to v14, offline.** Stop admission,
   schedules, workers, owners and every physical writer. Confirm the drain with
   `inspectRetainedDataDrain(session, schema)`, then call
   `upgradeActionLifecycle(session, schema)` with no new key or manifest inputs
   (CLI: `apply --schema=SCHEMA`). One transaction does the following:
   - adds private credential-effect storage, including the accepted flow
     continuation operation and indexed run and operation lookups;
   - keys graph nodes by `(namespace, id)`, with cascading composite edge
     references;
   - puts `COLLATE "C"` on every text identity column;
   - rebuilds the ready-content reference index with `COLLATE "C"`, so content
     retirement's protection check is an index lookup.

   It advances the owner epoch once, preserves sessions and retained authority,
   and is idempotent. Validate, then start the application. Schemas older than
   v13 run the [complete chain](#current-owner-schema-v14) first. Nothing
   upgrades at startup.
2. **Expect bytewise ID order.** Identity columns sort by code point (`"B"`
   before `"a"`), and the same node ID may now exist in two namespaces of one
   schema. Duplicate IDs within one namespace raise a typed conflict. Generated
   IDs are monotonic ULIDs.

#### Authorization policies

3. **Grant `recordMessage` wherever you grant `ensureMembership`.** Every
   visible message runs `thread.commands.recordMessage` in its transaction:
   `createThreadMessage`, channel ingress and scheduled delivery. A policy that
   grants only `ensureMembership` now refuses the whole send:

   ```ts
   collectionMutations: {
     thread: {
       create: {},
       update: {},
       commands: { ensureMembership: {}, recordMessage: {} },
     },
   },
   ```
4. **Replace boolean session grants and flow-kind arrays with exact grants.**
   The owner compares the proposed credential with the grant before it stores a
   session or flow, so derive both from trusted owner state or verified
   evidence, never from `intent.input`:

   ```ts
   // Before: sessions: { create: true }, and in pre-release builds of
   // Action flows, flows: { start: ["oauth"] }.
   return {
     sessions: { create: { principal: accountId, maxAge: 3600 } },
     flows: {
       start: { oauth: { continuation: "oauthCallback", maxAge: 300 } },
     },
   };
   ```

   - `sessions.create.principal` must equal the created session's principal.
     `maxAge` is a positive whole number of seconds, at most one year, and must
     cover the requested lifetime. For an HTTP route's
     `context.sessions.create({ id, principal, expiresAt })`, `expiresAt` minus
     the command time must fit within `maxAge`.
   - `flows.start` maps each kind to its exact continuation **alias** and a
     `maxAge` of at most 900 seconds. The requested lifetime, 300 seconds by
     default, must not exceed it.
   - A session ID and its principal may now differ. Later requests carry
     `principal: { kind: "session", id: accountId }` and
     `authorityBasis: { kind: "session", id: sessionId }`, and every command
     checks both against the stored session row.
   - For OAuth/OIDC logins, verify the provider's response with an owner-side
     `defineIdentityVerifier` and read it in policy through
     `evidence.get(alias)`. See
     [Owner-verified identity evidence](./authorization.md#owner-verified-identity-evidence).
5. **Use composition aliases, not stable Action IDs.** Policy `actions` maps and
   grants, server exposure, HTTP route `action`, handler `context.invoke`, SDK
   and browser Action calls, Tool bindings and flow continuations all take the
   alias, such as `saveNote`. A stable ID such as `notes.save` is no longer
   accepted. Stable IDs still name durable lifecycle events, and
   `intent.invocation.id` still carries the executing Action's or Processor's
   stable ID.
6. **Read `commandTime` and the policy context selectively.** The owner now
   reuses authorization decisions while their tracked dependencies stay
   unchanged (see
   [Authorization reuse](./authorization.md#authorization-reuse-during-an-action-run)).
   A decision that reads `context.commandTime` is never reused; destructuring it
   at function entry or spreading `{ ...context }` counts as reading it.
   Spreading, enumerating or serializing `authority`, `requestFacts` or the
   intent binds the decision to every field in that subtree, so requests that
   differ anywhere in it, such as by request or run ID, no longer share it. Such
   policies stay correct but evaluate more often. Read `commandTime` only in the
   branches that compare times, read only the fields a decision needs, and copy
   the context with property descriptors when an adapter must enrich authority
   (see [What `evaluate` receives](./authorization.md#what-evaluate-receives)).
   Read changing facts through declared `sources`, and register changed logic
   under a new revision: untracked closure state does not invalidate a reused
   decision.

#### HTTP

7. **Handle 401 and 403 separately.** An anonymous request refused by an Action
   policy, including Core HTTP Actions, returns **401**. A credential that was
   presented and refused keeps **403**. A session cookie that fails verification
   (revoked, expired, unknown or malformed) now counts as absent: the request
   runs anonymously and the response clears the cookie, so send users to sign in
   on 401. A host `authenticate` that verifies its own cookie returns
   `invalidSessionCookie: true` with an anonymous scope for a bad cookie, and
   `false` for a valid one.

#### Core behavior

8. **Pass `recipientIds: []` to address nobody.** A message that names no
   recipients now addresses the thread's agent participants other than the
   sender. Seeds, imports and notices that must not wake an agent pass an
   explicit empty list. Human recipients no longer start model calls.
9. **Expect tool output to reach the turn's initiator.** New tool calls and
   results record `visibility.initiatorId`, the human whose message started the
   turn, and keep it across agent-to-agent work. Under `public_status`, the
   default result policy, that person now reads the output. Other viewers
   receive the result message with `content: []` and `metadata.toolStatus`
   (`completed`, `failed` or `cancelled`); treat it as a settled status, not a
   failure or a pending call. `requester_only` stays agent-only. Messages stored
   before this release have no `initiatorId` and gain no initiator access;
   nothing is backfilled.

#### Execution limits

10. **Size the delivery ceiling for long work.** Deliveries and worker host
    calls now stop only at a six-hour safety ceiling, and a stalled model call
    fails by inactivity (90 s before visible content, 120 s after) with "The
    model stopped responding." If an Action can run longer, declare
    `defineAction({ deliveryTimeoutMs })`, or set `deliveryTimeoutMs` in
    `createCopilotz`. Configure the same value on the Gateway, every Worker and
    every shard: each peer applies its own limit. A provider that reasons
    silently for more than 90 s needs a larger `firstTokenTimeoutMs`. See
    [Execution liveness](./execution-liveness.md).

#### Operations

11. **Use the migration API instead of the scripts' internals.**
    `@copilotz/copilotz/migration` exports `exportOwnerBundle`,
    `importOwnerBundle`, `relocateOwnerSchema`, `migrateOwnerKeys`, the
    transfer-body readers and the restore helpers. The offline scripts are thin
    callers of it. See
    [Moving retained tenant data](./retained-data-migration.md).
12. **Align Oxian.** Copilotz depends on Oxian 0.23.1. Hosts that import Oxian
    directly use the same version.

#### Memory scopes

Memory (`memoryPlugin` from `@copilotz/copilotz/memory`) now keeps immutable
notes in three scopes. Grant agents `remember`, `search_memory`,
`inspect_memory` and `retire_memory` in `capabilities.tools`.
`remember({ text, scope })` appends immediately: `personal` belongs to the human
initiator, `space` to the thread's current Core space, and `thread` (the
default) to the conversation. Correct with
`remember({ text, scope, replaces: id })`; retire with
`retire_memory({ id, reason })`. Text is immutable. Retirement keeps an audit
record; it is not erasure. Direct and imported notes have
`lineage.checkpointId: null`, and note results now include `scope`.

**Replace `update_user_memory`.** It is removed, with no alias. Replace
`update_user_memory({ content })` with
`remember({ text: content, scope: "personal" })`, and `operation: "remove"` with
`retire_memory`, taking the note ID from search or the profile. Remove the old
name from tool grants, prompts, Action policies and imports. Agents that used it
need Memory installed. The old Action belonged to Built-in Tools and wrote
participant metadata; an alias would couple that plugin to Memory and keep an
incompatible result and category contract. `update_my_memory` (agent
configuration metadata) is unchanged.

Core space membership now selects a dedicated `memory-space:space:<spaceId>`.
Joining exposes it; leaving, moving or archiving removes access. Thread notes
stay private to their thread, including when two threads share a Core space.
Legacy custom spaces and explicit `memorySpaceAccess` sharing grants remain
stored but no longer expand agent visibility. Review and copy any facts that
should be shared into the chosen new space scope; do not blindly publish old
thread notes. Existing checkpoints and canonical thread notes stay in place. The
canonical thread write grant remains an internal consolidation fence.

#### Retained personal memory

No retained SQL schema upgrade is needed. The first personal write, search,
inspection, ordinary prompt preparation or profile opening lazily imports valid
`participant.metadata.memories.items` into personal notes. Each item gets a
SHA-256 ID from its participant and complete legacy value. Concurrent or
repeated imports converge, and retired imports are never recreated. The original
metadata (including category and malformed entries) is retained for recovery and
excluded from Core's system prompt. Imported text is available through ordinary
text search without embeddings. Stop all old-version writers before rollout;
editing legacy metadata afterward is not a supported memory interface.

The profile lists personal notes and offers **Forget** via the `personal_memory`
Action (`operation: "import" | "retire"`). Set `resources.chat.sender.id` to the
canonical participant ID (an authorized `externalId` lookup is also supported).
Register these leaves in the app's browser plugin (server policies still control
all access):

```ts
collections: { memoryNote: { placement: "server" } },
actions: {
  personal_memory: { id: "copilotz.memory.personal", placement: "server" },
},
```

#### Memory policies

The library cannot authenticate an application's humans or choose its access
policy. Keep those checks in the existing owner policy and compose
`memoryScopeConstraints(read, { threadId, initiatorParticipantId })`, exported
from `@copilotz/copilotz/memory`, after resolving trusted Core provenance. Bind
that policy to `memoryNote`, `memorySpace`, `memorySpaceAccess` and
`longTermMemory`, and declare `thread`, `space` and `participant` policy
sources. The helper provides read predicates and separate mutation constraints;
the owner re-reads membership at authorization and commit. Merge these
constraints with the app's existing grants; do not replace them with
unrestricted collection access.

- For agent Actions and prompt preparation, derive the initiator from the
  authenticated Core workflow or tool-plan provenance, never from model input or
  an arbitrary human in the thread. Preserve it across nested agents. Bind the
  thread to authorized work; a valid ID alone grants nothing.
- Permit the personal import's participant read and scoped note and container
  creates, including in the message router's context preparation. Do not permit
  metadata writes for personal memory. Keep ordinary Core collection grants.
- For profile calls, expose `personal_memory` and bind
  `actionMetadata.initiatorParticipantId` to the authenticated participant. Use
  `memoryScopeConstraints(read, { initiatorParticipantId })` without a thread,
  and constrain browser `memoryNote` reads the same way. Never accept a
  participant ID from the Action input as authority.
- Scheduled tool creation captures `metadata.creatorParticipantId` from trusted
  Action metadata and preserves it on updates. Dispatch uses that stored human
  as initiator. Host-authored jobs must supply this server-derived metadata;
  backfill existing jobs only when the creator is known. Protect this field in
  custom job-write policies. Unknown or non-human creators get no personal
  scope.
- Keep Memory tools' `requester_only` history visibility. Apply the app's usual
  message, asset and operation policies to retained tool results and agent
  replies; scope authorization does not erase information already published in
  conversation history.

Automatic personal context is independent of the consolidation threshold. It is
omitted unless all thread participants can be resolved and the initiator is the
only human. At most 20 active items, in stable ID order and at most 8,000 text
characters, are inserted immediately before the latest message. The system,
tools and preceding history remain unchanged. In shared threads the initiating
human's personal scope is available only through explicit tools.

#### Prompt context

**Core no longer emits `## USER METADATA`.** Previously it selected the first
human in a thread and copied arbitrary metadata into the system prompt. There is
no compatibility switch for that dump. Installing Memory supplies the curated,
initiator-based personal block described above; without Memory, Core does not
automatically supply personal facts.

If an app relied on other metadata fields (for example, a preferred language),
register an explicit `defineContextResource` under `resources.promptContext`.
Use `initiatorParticipantId`, authorized collection reads, an allowlist of
fields and values, and the app's shared-thread disclosure policy. Return
`placement: "before_latest_message"` so changing facts leave the system, tools
and preceding history unchanged. Do not stringify a whole participant or its
metadata, and do not fall back to the first human. See the
[curated contributor example](../plugins/core/authoring/define-context/README.md#curated-user-facts).
Grant that contributor only the participant and thread reads its policy needs.

Agent `workingMemory`, `expertise` and `learnedPreferences` remain agent
configuration, separate from the three memory scopes. `update_my_memory` keeps
its existing storage and API. Core now renders those three fields as
`## AGENT CONFIGURATION` before the latest message, instead of
`## YOUR PERSISTENT MEMORY` in the system prompt. Object keys are sorted for
stable bytes; unrelated agent metadata is not included. Agent resource identity
and instructions remain in the system prompt. These placement changes incur a
one-time prefix change on upgrade; later metadata and configuration changes do
not invalidate that prefix.

### New surfaces in 0.90.0

#### Device sockets and live reads

13. **Send cookie credentials explicitly on the device socket.** Browsers that
    authenticate with the HttpOnly session cookie select it in the hello:

    ```ts
    const device = createDeviceTransport({
      url: "wss://app.example/api/device",
      credentials: () => ({ cookie: true }),
    });
    ```

    Header-token clients send a nonempty `authorization` or `x-api-key` value
    instead. Empty credentials are refused, and so is a cookie on a socket whose
    `Origin` was missing or not allowed.
14. **List cross-origin clients in `allowedOrigins`.** `/device` refuses a
    foreign or opaque `Origin` before upgrading. Same-origin sockets need no
    configuration. Other origins are listed as canonical HTTP(S) origins:
    `defineServerFacade({ allowedOrigins: ["https://app.example"] })`.
    Non-browser clients that send no `Origin` authenticate with header
    credentials only.
15. **Expect bounded live reads.** Each device socket holds at most 16
    subscriptions by default (`deviceLimits.maxSubscriptions`), and each
    principal 32 attached reads. Filters are limited to 64 predicate nodes and
    32 `in` values. `jsonEquals`, `eqIgnoreCase` and `inIgnoreCase` are refused
    with `subscription_query_refused`; capacity refusals use
    `subscription_capacity_exceeded`. Live windows may be ordered by a scalar
    field or `createdAt`/`updatedAt`. Live message windows now defer bodies over
    budget: handle entries marked `deferred` with a `byteLength`.

#### Action sessions

16. **Check the session cookie name.** The Action-session cookie, new in this
    release, defaults to `__Host-copilotz_session`: Secure, HttpOnly, `Path=/`,
    no `Domain`. A `__Host-` name refuses a `domain`, `secure: false` or another
    `path`, so pick a different `sessionCookie.name` if you need those. Update
    proxies, tests and host `authenticate` callbacks that read the cookie by
    name. A request that carries the configured cookie twice is refused with
    `duplicate_session_cookie`.
17. **Resolve the actor for Action-session requests.** The owner verifies an
    Action-session cookie after `authenticate` returns, so `authenticate` cannot
    supply that request's actor. Add `resolveActor` to the facade. It runs after
    verification on every authentication path, receives the verified `scope` and
    tenant-scoped `read` services, and its result replaces the actor
    `authenticate` returned:

    ```ts
    defineServerFacade({
      authenticate,
      async resolveActor({ scope, read }) {
        // Keep the actor that authenticate verified for other credentials.
        if (scope.authority.principal.kind !== "session") return scope.actor;
        const [participant] = await read.list("participant", {
          where: { externalId: scope.authority.principal.id },
        });
        return participant ? { id: participant.id } : undefined;
      },
    });
    ```

    The resolved actor sets the request scope that Core routes read and the
    ingress proof. Credential-dependent Action metadata still comes from the
    owner policy's `actionMetadata`. Core routes that need a viewer, such as the
    message and message-asset reads, refuse a request without an actor with
    `403 actor_required` instead of failing with 500.

#### Browser runtime and chat UI

18. **Declare `url` on Views a link may open.** A View is addressable from URL
    state only when its definition sets `url: true` or
    `url: { queries: "run" }`. URL values carry identifiers only: a scalar, or a
    flat record of scalars.
19. **Start held reads from a user gesture.** In a View opened from a URL, and
    in every View it nests, `ctx.readAction` returns status `held` and calls
    nothing until a user gesture calls `refresh()`. `ReadStatus` renders a Load
    button for it. `url: { queries: "run" }` opts a View out when no query input
    derives from the URL value.
20. **Handle `ReadState` `failed`.** A one-shot query read whose attempt failed
    is `failed` and waits for `refresh()`. `stale` now means only a read that
    recovers by itself, such as a reconnecting live read. `ReadStatus` renders
    `failed` with Try again.
21. **Compose the chat shell.** Pre-release builds' focus/context workspace is
    removed: `workspace`, `workspaceNavigation`, `workspaceUrlStorageAdapter`,
    the `ui*` workspace Actions, the navigator and the `resources.navigation`
    entries.
    - Compose `uiWebPlugin({ navigation, preferences, core })` from `/ui/web`.
      `navigation` and `preferences` name storage adapters, and `core` is your
      `createCoreWebPlugin(...)` instance if you customize it.
    - Store navigation with
      `shellUrlStorageAdapter(browserShellHistory(window))` and pass
      `show: shellNavigation(() => runtime)`.
    - Grant progressive replies, Stop and uploads with
      `adapters: { core: { feed: threadFeedAdapter(client) } }`.
    - Configure chat through `resources.chat`: `sender` (required to send),
      `agents` (added to new chats) and `defaultRecipients` (`"first"` by
      default, or `"all"`).
    - Add Space tabs with `resources.spaceSections.<id>` and administration tabs
      with `resources.adminSections.<id>`. `null` hides a built-in.
      `createAdminWebPlugin({ core })` registers a user-menu page.
    - Call `bindShellSession(runtime, device)` to show `resources.shell.signIn`
      when the session is revoked.

    See [Web runtime and Views](./web-runtime-and-views.md).
22. **Mark tool renderers that should show while a call runs.** A reply's tool
    calls now collapse into one quiet activity row. A renderer registered as
    `{ view }` alone shows only under its step's **View details**; it no longer
    opens while the call runs. Add `live: true` to draw it in the message while
    the call runs and settle it into a compact card, and set its `audience`:
    `everyone` (the default) or `technical`, which starts as a slim strip unless
    the person turned on **Show technical details**. `inline: true` still
    replaces the step, as `ask` does.

    ```ts
    toolRenderers: {
      terminal: {
        view: "appTerminal",
        live: true,
        audience: "technical",
        icon: "terminal",
      },
    },
    ```

    Optionally add `summary`, a View that states the step in plain words.
    `batch` lets one summary speak for consecutive calls to the same tool, and
    `summaryResult` loads the result for it. A live View can call
    `useToolDisplay()` from `/core/web` to draw its compact `card`. See
    [Tool renderers](./web-runtime-and-views.md#tool-renderers).

#### Shard hosts

Pre-release builds of the shard role (`@copilotz/copilotz/shard`) change as
follows:

23. **Authenticate shard controllers from headers.**
    `createShardControllerHandler` requires `authenticate(request)`, which runs
    on a bodyless copy of the request before the body is read. A refusal cancels
    the body and returns 403. Move the bearer or identity check from `authorize`
    into `authenticate`; keep `authorize(request, input)` for the parsed work's
    scope.
24. **Namespace non-worker sessions.** Computers, browsers and connectors occupy
    reserved session IDs, `shard:<kind>:<id>`, built by
    `shardSessionId(kind, id)`:
    - pass `kind: "computer" | "browser" | "connector"` to `createShardWorker`
      for every non-owner worker. Without it, the worker connects in the
      `worker` namespace, admission refuses it with `principal_kind_mismatch`,
      and the worker sees an authentication failure;
    - in a custom `admit`, `identity.workerId` is the namespaced ID, so compare
      it with `shardSessionId(kind, logicalId)`;
    - dispatch still takes the logical target ID plus `kind`;
    - the owner-facing `sessions` list only `worker` sessions.

## Current owner schema: v14

Each physical database schema has one fenced owner shared by its namespaces.
Fresh, absent-only provisioning installs **v14** and the operation catalog
fingerprint **`stream-taxonomy-content-v1`**. Startup validates the complete
current shape; it never upgrades an existing schema.

There is one offline chain: **v5–v10 → v11 → owner keys v12 → authority v13 →
credential effects and flow admission v14**. Rehearse on a restored disposable
backup. Stop admission, schedules, workers, owners and every physical writer,
and keep them stopped through v14. Existing v11, v12 or v13 schemas enter at
their next step; never relabel a schema or skip a step.

1. Run `inspectRetainedDataDrain(session, schema)` (or the CLI `drain`).
   Deliveries, obligations, operations, streams, begun effects and physical
   writers must have confirmed terminal states. Cancellation requests are
   insufficient; also drain application-owned external-work journals.
2. For v5–v10, call `prepareRetainedDataUpgrade(session, schema)` and retain its
   plan privately. Preparation records the source, **target v11**, and unique
   identity under reserved marker `0`. Review the exact fingerprint, physical
   copies and explicit ownership decisions. Repeat preparation to recover the
   same identity after interruption. External stores require explicit mappings.
3. Call
   `upgradeActionLifecycle(session, schema, { plan,
   reviewedFingerprint: plan.fingerprint, contentDecisions, ownerKeys })`.
   The retained-data transaction rechecks drain, bytes and accepted intent,
   installs v11, converts logical content and sequence, and preserves immutable
   history. The v11 → v12 transaction then reencrypts retained protected values
   under an owner data key wrapped by the application's master adapter.
   `ownerKeys` supplies `sourceAdapter`, `masterAdapter`, and, if needed,
   original protected `bindings` and `readExternalBody`. When starting at v11,
   omit the retained plan. The standalone `migrateOwnerKeys` API also performs
   exactly this step and stops at v12.
4. At v12, run `inspectAuthorityUpgrade(session, schema)` (CLI
   `authority-inventory`). Review the resulting invocations and ingress events
   against application policy. Build an explicit `AuthorityUpgradeManifest`
   containing policy revisions, exact invocation/event digests, authority
   bindings, and any required original Action schemas or ingress provenance.
   Inspect after key conversion because reencrypting captures can change their
   digests. Even an empty inventory requires an explicit empty manifest.
5. Call `upgradeActionLifecycle(session, schema, { authority })` to commit v12 →
   v13. This validates every binding, writes the accepted manifest receipt,
   invalidates old transport attachments, and fences the old owner epoch.
6. The same call then commits v13 → v14 in one transaction: private credential
   effect storage, indexed run/operation lookup, accepted flow continuation
   bindings, namespace-local `(namespace, id)` node identity, and `COLLATE "C"`
   on text identity columns and the ready-content reference index. It rechecks
   drain, advances the owner epoch once, and preserves sessions and retained
   authority. Starting at v13, call `upgradeActionLifecycle(session, schema)`
   without new key or manifest inputs. Validate the v14 schema and catalog, then
   start the application.

When all reviewed inputs are already available,
`upgradeActionLifecycle(session, schema, { plan, reviewedFingerprint,
contentDecisions, ownerKeys, authority })`
runs the entire chain in order. Missing inputs stop at the last committed
checkpoint with `UpgradeStepRequiredError`:
`copilotz_upgrade_owner_keys_required` at v11 or
`copilotz_upgrade_authority_required` at v12. Its `fromVersion` and `toVersion`
identify the next step. These checkpoints are not ready for this runtime.

Each step rechecks drain inside its exclusive transaction. Failed transactions
roll back that step. After a lost commit reply, inspect the marker or retry the
same inputs. Retained plan/decision fingerprints, the key-migration receipt, and
the authority-manifest fingerprint make retries resumable and idempotent.
Changed reviewed plans, decisions or authority manifests are rejected on replay.
Historical sequence follows canonical position order and preserves cursors; new
owner writes follow commit order.

The repository's [offline guide](../scripts/upgrade-retained-data.md) gives the
exact CLI commands and adapter-module contract. No step runs at startup.

### Receipt authority limitations

Historical logical Collection receipts bound only to a physical `worker:`
principal do not prove the original Action/Processor authority. The current
conversion refuses them without advancing readiness. It cannot guess from
receipt keys, accept an operator override, or grant a replacement worker access.
Keep such data offline until a separately reviewed conversion can establish its
original durable invocation binding. Fixed-principal receipts and supported
pre-conversion histories without owner receipts remain eligible.

Owner schemas missing the required receipt-reader column are also refused by
current validation. Do not relabel them or add a runtime compatibility path. See
the offline guide for the exact supported inventory.

### Offline database deadlines and progress

The offline CLIs (`upgrade-retained-data.ts`, `migrate-action-content.ts`,
`migrate-ingress-provenance.ts`, `provision-content-indexes.ts`, and
`owner-bundle.ts`) disable the per-statement online deadline and allow a 24-hour
client request deadline. This does not change application connection defaults.
Use the same explicit options in application migration modules and `deno eval`
snippets:

```ts
const database = await openManagedOminipgDatabase({
  url: Deno.env.get("COPILOTZ_MIGRATION_DATABASE_URL"),
  statementTimeoutMs: null,
  requestTimeoutMs: 24 * 60 * 60 * 1000,
});
```

Setting only `statementTimeoutMs: null` leaves the default 30-second client
request deadline in place. A long transaction must fit within the client
deadline as well. Keep all producers stopped; these settings are for the
explicit offline connection, not the running application.

Long phases emit `[upgrade:SCHEMA] PHASE done/total` progress to **stderr**.
Stdout remains the CLI's JSON result, and review-plan fingerprints keep their
existing format. Progress within a transaction is not a committed checkpoint.
After interruption, inspect the durable marker and repeat the same reviewed
command; do not restart producers based on a progress line. Preparation and
finalization still verify retained bytes and event-body digests.

The native database path batches up to 2,000 records, with a 16 MiB byte budget
for physical reads. Individual large bodies retain the chunked prefix reader;
physical layout conversion can require memory for the largest individual body.
External heads and full prefix digests use bounded concurrency (default 16).
Rehearse using the same storage adapter and client/database hardware as the
cutover. See [the synthetic benchmark](../scripts/benchmark-offline-upgrade.md)
for reproduction commands, measured results and their limits.

## The pain

Your team-notes application has been running for weeks. Its database holds
Notes, completed operations and the Event history that browsers replay. A new
Copilotz release arrives, and someone also wants to rename `notes.capture` to
something clearer and add an optional `body` field to Note.

Each of those changes touches data that already exists. Suppose you bump the
package and restart without a plan. The new version can refuse to start because
its catalog check fails, or old workers can keep writing beside new ones.
Deliveries addressed to the old Processor ID stay outstanding with no consumer.
Browsers that resume from a stored cursor get `invalid_replay_cursor` instead of
history.

## The problem

Copilotz stores three independent things, and each one evolves differently:

1. **Physical schema.** The SQL tables for Events, Collections and Bodies are
   validated against owner schema v14. Startup provisions fresh Core tables and
   validates existing ones; incompatible Core schemas are rejected. Declared
   Collection indexes are provisioned separately as described below. Stored
   records are never reset or rewritten.
2. **Durable identities.** Plugin IDs, Collection names, Action IDs, Processor
   IDs, retry keys and call order are recorded in Events and deliveries. They
   behave like primary keys, not like labels.
3. **Your JSON records.** Collection schemas validate new writes. They do not
   backfill or rewrite records that are already stored, and there is no
   record-migration hook.

Installing a new library version changes none of these by itself. So you need an
explicit contract: what stays fixed, what you plan yourself, and which operator
steps a release requires.

## The solution

### Pin one release for every subpath

All public entrypoints (`/core`, `/events`, `/streams`, `/persistence`,
`/server` and the rest) belong to one package version and share one framework
identity. Choose one version range for the package, commit the lockfile that
records the exact resolved version, and upgrade every subpath together.

On Deno, edit the existing `imports` property in `deno.json`. Replace only the
`@copilotz/copilotz` entry and keep your other imports:

```json
{
  "imports": {
    "@copilotz/copilotz": "jsr:@copilotz/copilotz@^0.90.0"
  }
}
```

If Deno holds back a release published in the last 24 hours, see
[Before you start: Deno](./getting-started.md#deno).

On Node:

```sh
# Add the package from JSR and record the resolved version in the lockfile.
npx jsr add @copilotz/copilotz@^0.90.0
```

Generated or bundled plugins must keep framework imports external so that they
resolve to the same package. Before you upgrade, read every CHANGELOG entry
between your version and the target. An entry that names an operator step, such
as the v14 schema upgrade in 0.90.0, needs that step before the new version
serves traffic.

### Keep durable identities stable

- **Processor IDs.** Outstanding deliveries name their consumer as
  `processor:<id>`. If you rename a Processor, the new one does not inherit that
  work. Keep the ID and change the implementation, or drain the old deliveries
  before you remove it.
- **Collection names and Action IDs.** Records and recorded Action calls refer
  to them. Aliases such as `saveNote` can change in TypeScript; the ID
  `notes.save` cannot.
- **Retry keys and call order.** Keys such as
  `` `${context.operationKey}:save-note` `` and the Processor's `save-request`
  call key identify retried work. If you change them, or reorder Action calls
  inside one handler, an in-flight retry can repeat or skip work.
- **Plugin IDs.** Dependencies and generated plugins resolve by ID.

### Evolve record schemas deliberately

The optional `body` property added to Note works against existing text-only
Notes. Old records simply lack the field, and the change needs no SQL migration,
because the JSON schema lives in your definition rather than in the physical
tables. Do not generalize that to every schema edit. Making a field required,
changing a type, adding constraints old records violate, or splitting a record
all need an application-managed plan: read both shapes, update records through
your own Actions with stable keys, then tighten the schema. Copilotz backfills
nothing for you.

All namespaces in one physical schema share the same tables. A namespace
isolates data, not physical-schema changes; separate physical schemas are
upgraded separately.

Collection `indexes` are physical database declarations. Before serving this
release on an existing tenant schema or with validation-only startup, run
`provisionCollectionIndexes(session, schemaName, definitions)` with the complete
composed Collection definitions. Default database provisioning performs this
step automatically. It adds indexes and enforces declared uniqueness, but never
rewrites rows or drops old indexes. Resolve any duplicate-key violation through
an explicit data correction; provisioning does not choose which record to keep.
Provision populated schemas before admitting work: index creation now runs
inside the schema owner command and holds its queue until commit. See
[Collections](./collections.md#provision-declared-indexes).

### Test against disposable data only

Tests omit the database option and use the private in-memory default. If you
rehearse an upgrade, restore a backup into a fresh `file://` directory or a
scratch PostgreSQL database. Never point a test or rehearsal at existing data,
and never delete a data directory to "start over".

### Validate instead of provisioning at startup

By default an application provisions a fresh Event schema and operation catalog
at startup, and validates existing ones. If your database role should not create
them, set `engine: { provisionDefaultDatabaseSchema: false }` in the options you
pass to `createCopilotz`. Startup then validates the Event schema and the
operation catalog, and fails if either is missing or incompatible. An operator
must provision both beforehand, not just one index. The flag covers these two
layers; check each optional feature you enable for its own provisioning needs.

## Reference

### Upgrade layers

| Layer              | Current state                | How it is applied                                                                                          |
| ------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Event/owner schema | v14                          | Provision an absent schema; use the reviewed offline retained-data path for supported existing inventories |
| Operation catalog  | `stream-taxonomy-content-v1` | Installed by fresh provisioning or the same retained-data conversion                                       |
| Core history index | Optional since 0.85.1        | `provisionCoreHistoryIndexes`, once per physical Core schema                                               |

- `upgradeOperationCatalog` always takes exclusive catalog and Event locks, even
  when the catalog is already current. Use `validateOperationCatalog` for a
  read-only check.
- The backfill runs in transactions, and final validation runs after commit. A
  failed transaction rolls back, but an error thrown after commit does not mean
  nothing changed. Validate before you retry.
- A query-only driver adapter cannot supply atomicity; the session needs a real
  transaction.
- The history index is not part of the catalog upgrade. A concurrent build needs
  PostgreSQL outside a transaction, and the non-partial index adds write and
  storage cost. Operator scripts are your repository's code, not a package CLI.
- Replay retention keeps settled operations for a 24-hour grace period until
  `app.maintenance(...)` prunes them. `operationRetentionMs: null` disables
  pruning. This is independent of the 15-minute HTTP observation renewal.

## What this unlocks

- Upgrade on a schedule you control, with a backup and a tested rollback.
- Refactor handlers freely while their IDs and keys carry in-flight work.
- Ship the known `body` addition without downtime, and plan stricter changes as
  ordinary application work.
- Run application roles that validate rather than provision the Event schema and
  catalog.

## Next steps

- [Events, deliveries and recovery](./events-deliveries-recovery.md): what
  durable identities mean during retries and recovery.
- [Observation performance](./observation-performance.md): the indexed
  observation design behind the 0.85.0 upgrade.
- [History performance](./history-performance.md): provisioning the Core history
  index.
- [Persist and recover](./getting-started/part-2-verify-and-recover/07-persist-and-recover.md):
  choosing the database URL your hosts share.

## External storage during offline cutover

First use the pruner's `--list-unterminated`, review the digest-bound JSON,
dry-run `--abandoned=FILE.json`, then retire with `--apply --writers-stopped`.
Refused closures must be resolved before preparing. Retirement performs SQL
deletes only; it does not read, write or delete physical content.

Both `prepare` and `apply` accept `--storage=MODULE.ts`. The module
default-exports `RetainedDataUpgradeStorage`: optional `storeFor`,
`streamBackend`, `copyMappings` and `concurrency`. The CLI validates its shape
before opening the database. `storeFor(location, session)` may return
`undefined` for the platform database store. Unknown external backends still
fail closed. `--concurrency=16` overrides the module; the supported range is
1–256. Concurrency changes no plan fields or fingerprints. Duplicate physical
identities share one check, and conflicting length/digest/outcome claims still
fail.

For an S3-compatible backend, create `migration-storage.ts` in the repository
root (use the exact backend ID, bucket, prefix and protocol of the retained
data):

```ts
import { createBodyStorageRuntime } from "./runtime/content/storage.ts";
import type { RetainedDataUpgradeStorage } from "./runtime/actions/upgrade.ts";

const config = {
  backendId: Deno.env.get("MIGRATION_BACKEND_ID")!,
  endpoint: Deno.env.get("MIGRATION_S3_ENDPOINT")!,
  region: Deno.env.get("MIGRATION_S3_REGION")!,
  bucket: Deno.env.get("MIGRATION_S3_BUCKET")!,
  accessKeyId: Deno.env.get("MIGRATION_S3_ACCESS_KEY_ID")!,
  secretAccessKey: Deno.env.get("MIGRATION_S3_SECRET_ACCESS_KEY")!,
  prefix: Deno.env.get("MIGRATION_S3_PREFIX") ?? "",
  pathStyle: true,
};
const runtime = createBodyStorageRuntime({ storage: { type: "s3", config } });
const store = runtime.writer!;
export default {
  storeFor: (location) =>
    location.kind === "object" && location.backendId === store.backendId
      ? store
      : undefined,
  // Set this only if the retained operation streams use this external backend.
  // Otherwise omit it to retain the default database stream backend.
  // streamBackend: { kind: "object", backendId: store.backendId },
  concurrency: 16,
} satisfies RetainedDataUpgradeStorage;
```

For native GCS objects use the existing `createGcsBodyStore` adapter and map its
exact `object` backend ID in the same way. S3 compatibility does not convert
native GCS object layouts into S3 manifests. `copyMappings` points at already
imported physical keys; it does not perform copies. Keep credentials in the
environment, and use credentials that permit only reads for the external source.

```sh
deno run -A scripts/upgrade-retained-data.ts prepare --schema=SCHEMA \
  --storage=./migration-storage.ts --concurrency=16 --plan=review.json
# Review the plan and supply the required keys, ownership and authority inputs.
deno run -A scripts/upgrade-retained-data.ts apply --schema=SCHEMA \
  --storage=./migration-storage.ts --plan=review.json --reviewed=FINGERPRINT \
  --owner-keys=./migration-keys.ts
```

### Store operation audit

| Step                                     | External BodyStore operations                                                               | Writes                                                                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pruner/list/retire and drain             | None                                                                                        | Retirement deletes approved SQL closures                                                                                                                         |
| Prepare                                  | `head`, `readRange` in 1 MiB digest chunks                                                  | Database physical-format/stream migration and reserved marker; no external mutations                                                                             |
| Retained finalization to v11             | Repeats `head`, `readRange` and digest verification                                         | SQL logical-body/copy catalog, ownership, document conversions and schema changes; no external mutations                                                         |
| Owner-key conversion to v12              | `head`, `readRange` via the storage module, unless `ownerKeys.readExternalBody` is supplied | Imports external bytes into database-owned copies and rewrites protected values; marks source catalog copies orphan/noncollectable; leaves source objects intact |
| Authority/v13 and credential effects/v14 | None                                                                                        | SQL schema and authority changes                                                                                                                                 |

The built-in S3 adapter implements those reads using manifest and immutable-part
GETs; native GCS uses metadata GETs and generation-bound media range GETs. One
BodyStore call can make multiple HTTP requests. The upgrade invokes no external
`put`, `reserve`, `append`, `fence`, `seal`, `terminate`, `abort`, maintenance
list or delete. There is no external mutation opt-in because none is needed.
Custom modules are executable operator code and must uphold the read-only
contract.

Provision database capacity for the v12 imports, including transaction/WAL
space. That step currently retains imported external bytes in memory and reads
them sequentially; the configurable concurrency applies to prepare/v11
inspection. Physical import or later external garbage collection is a separate
operator procedure. Keep all writers stopped until the entire chain reaches v14.
