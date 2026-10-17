/** Private registered preparation -> child Action capture. The only durable
 * input owner is the child's existing requested event/body/catalog lifecycle.
 * No renderer, SQL, resource value or rendered text is accepted from the wire. */
import { ownerPreparationIntent } from "./preparation-intent.ts";
import { assertJsonValue } from "../json.ts";
import type { SqlExecutor } from "../events/session.ts";
import type { DurableEvent } from "../events/types.ts";
import { createEventStore } from "../events/store.ts";
import {
  type OwnerChildActionParentReference,
  type OwnerChildActionReference,
  parseOwnerChildActionParentReference,
} from "../execution/child-action-port.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import type { ViewShows } from "../views/definition.ts";
import { viewShowsKey } from "../views/definition.ts";
import type { OwnerChildActionParent } from "./child-action.ts";
import type {
  OwnerCaller,
  OwnerCommand,
  OwnerCommandContext,
  OwnerCommandHandler,
  OwnerCommandInputDefinition,
  OwnerJson,
} from "./boundary.ts";
import { ownerTableNames } from "./schema.ts";
import { assertOwnerOrdinaryValue } from "./ordinary-value.ts";
import {
  OWNER_PREPARATION_SCHEMA,
  type OwnerPreparationCapture,
  parseOwnerPreparationCapture,
  preparationCaptureFromMetadata,
} from "./preparation-capture.ts";
import {
  createOwnerPreparationRenderer,
  type PreparedViewSelection,
} from "./preparation-render.ts";
import {
  createOwnerPreparationResources,
  type OwnerPreparationResourcesOptions,
  type PreparationResourceCoordinate,
} from "./preparation-resources.ts";
import type { OwnerPreparationSource } from "./preparation-source.ts";

import {
  OWNER_CHILD_ACTION_PREPARATION,
  ownerPreparationChildKey,
  ownerPreparationKey,
} from "../execution/preparation-call.ts";
export {
  OWNER_CHILD_ACTION_PREPARATION,
  ownerPreparationKey,
} from "../execution/preparation-call.ts";
/** Detached constructor facts for the bounded startup compatibility proof.
 * These facts neither authorize a caller nor include current renderer/value data. */
export type OwnerPreparationHistoryRegistration = Readonly<{
  name: string;
  source: string;
  actionId: string;
  modes: readonly string[];
  resources: readonly PreparationResourceCoordinate[];
}>;
export type OwnerPreparationRegistration = Readonly<{
  source: string;
  actionAlias: string;
  shows: ViewShows;
  modes: readonly string[];
  resources?: readonly PreparationResourceCoordinate[];
  /** Registered pure mapper; it receives only the one-shot rendered text. */
  mapInput(
    text: string,
    context: Readonly<
      {
        selection: PreparedViewSelection;
        hints: Readonly<{ mode: string; renderer: "text" }>;
        signal: AbortSignal;
      }
    >,
  ): OwnerJson | Promise<OwnerJson>;
}>;
/** Transaction-local methods implemented by the actual child admission module.
 * They recheck the current parent/target and share its ordinary append path. */
export type PreparationChildAdmission = Readonly<{
  authorizePreparedTarget(
    tx: SqlExecutor,
    caller: OwnerCaller,
    parent: OwnerChildActionParentReference,
    actionAlias: string,
    operationKey: string,
    time: string,
    command: OwnerCommand,
  ): Promise<Readonly<{ parent: OwnerChildActionParent; actionId: string }>>;
  inspectPrepared(
    tx: SqlExecutor,
    caller: OwnerCaller,
    parent: OwnerChildActionParentReference,
    reference: OwnerChildActionReference,
    time: string,
  ): Promise<DurableEvent>;
  admitPrepared(
    input: Readonly<
      {
        parent: OwnerChildActionParentReference;
        actionAlias: string;
        operationKey: string;
        input: OwnerJson;
        preparation: OwnerPreparationCapture;
      }
    >,
    context: OwnerCommandContext,
  ): Promise<OwnerChildActionReference>;
}>;
export type OwnerPreparedInputContext = Readonly<{
  caller: OwnerCaller;
  sourceEventId: string;
  deliveryId: string;
  actionId: string;
  namespace: string;
  purpose: "claim" | "input" | "mutation" | "result";
  commandTime: string;
  signal: AbortSignal;
}>;
function fail(code = "preparation_invalid"): never {
  throw Object.assign(new Error(code), { code });
}
function text(value: unknown): string {
  if (
    typeof value !== "string" || !value || value !== value.trim() ||
    value.length > 1024
  ) fail();
  return value;
}
function json(value: unknown): OwnerJson {
  assertJsonValue(value, { maxDepth: 32, maxNodes: 20_000 });
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 65_536) {
    fail("preparation_limit");
  }
  return structuredClone(value) as OwnerJson;
}
function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, OwnerJson> {
  const copy = json(value);
  if (
    !copy || typeof copy !== "object" || Array.isArray(copy) ||
    Object.keys(copy).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(copy, key))
  ) fail();
  return copy as Record<string, OwnerJson>;
}
function canonical(value: OwnerJson): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${
      Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${
          canonical((value as Record<string, OwnerJson>)[key])
        }`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}
function parentReference(input: unknown): OwnerChildActionParentReference {
  try {
    return parseOwnerChildActionParentReference(input);
  } catch {
    fail();
  }
}
function childReference(input: unknown): OwnerChildActionReference {
  const value = exact(input, [
    "namespace",
    "actionId",
    "executionId",
    "eventId",
    "deliveryId",
  ]);
  Object.values(value).forEach(text);
  return value as OwnerChildActionReference;
}
const childKey = ownerPreparationChildKey;
type PreparationInput = Readonly<{
  parent: OwnerChildActionParentReference;
  preparation: string;
  operationKey: string;
  recordId: string;
  actionId: string;
  source: string;
  hints: Readonly<{ mode: string; renderer: "text" }>;
}>;
export function createOwnerPreparations(
  options: Readonly<{
    ownerId: string;
    schema: string;
    registry: PluginRegistry;
    children: PreparationChildAdmission;
    source: OwnerPreparationSource;
    preparations: Readonly<Record<string, OwnerPreparationRegistration>>;
    projectResource: OwnerPreparationResourcesOptions["projectResource"];
    authorizeResource: OwnerPreparationResourcesOptions["authorizeResource"];
    maxPendingRenders?: number;
    renderTimeoutMs?: number;
    maxBytes?: number;
  }>,
) {
  const ownerId = text(options.ownerId);
  const schema = options.schema;
  const tables = ownerTableNames(schema);
  const source = {
    capture: options.source.capture.bind(options.source),
    authorizeOriginal: options.source.authorizeOriginal.bind(options.source),
  };
  const children = {
    authorizePreparedTarget: options.children.authorizePreparedTarget.bind(
      options.children,
    ),
    inspectPrepared: options.children.inspectPrepared.bind(options.children),
    admitPrepared: options.children.admitPrepared.bind(options.children),
  };
  const renderer = createOwnerPreparationRenderer({
    registry: options.registry,
    maxPending: options.maxPendingRenders,
    timeoutMs: options.renderTimeoutMs,
    maxBytes: options.maxBytes,
  });
  const registrations = new Map(
    Object.entries(options.preparations).map(([name, registration]) => {
      text(name);
      const source = text(registration.source);
      const actionAlias = text(registration.actionAlias);
      const action = Object.hasOwn(options.registry.actions, actionAlias)
        ? options.registry.actions[actionAlias]
        : undefined;
      if (!action) fail();
      const actionId = text(action.id);
      const shows = json(registration.shows) as ViewShows;
      viewShowsKey(shows);
      const modes = [...registration.modes].map(text);
      if (
        !modes.length || new Set(modes).size !== modes.length ||
        typeof registration.mapInput !== "function"
      ) fail();
      // Capture once, then validate the same inert coordinates in the resource
      // helper. History facts must not re-read mutable registration options.
      const resourceCoordinates = json(
        registration.resources ?? [],
      ) as readonly PreparationResourceCoordinate[];
      return [name, {
        resourceCoordinates,
        source,
        actionAlias,
        actionId,
        shows,
        modes,
        mapInput: registration.mapInput,
        resources: createOwnerPreparationResources({
          registry: options.registry,
          resources: resourceCoordinates,
          projectResource: options.projectResource,
          authorizeResource: options.authorizeResource,
          maxBytes: options.maxBytes,
        }),
      }] as const;
    }),
  );
  const readStore = (tx: SqlExecutor) =>
    createEventStore({
      schema,
      session: {
        query: tx.query.bind(tx),
        transaction() {
          throw new Error("Preparation reads cannot open transactions");
        },
      },
    });
  const authorized = new WeakMap<
    SqlExecutor,
    { input: PreparationInput; namespace: string }
  >();
  const inputDefinition: OwnerCommandInputDefinition = {
    async normalize(raw) {
      const value = exact(raw, [
        "parent",
        "preparation",
        "operationKey",
        "recordId",
        "hints",
        "targetActionId",
      ]);
      const preparation = text(value.preparation);
      const registered = registrations.get(preparation);
      if (!registered) fail();
      // This asserted target is supplied by the bound Action caller. It cannot
      // change the registered target, including on compatible receipt replay.
      if (text(value.targetActionId) !== registered.actionId) {
        fail("preparation_forbidden");
      }
      const hints = exact(value.hints, ["mode", "renderer"]);
      if (
        !registered.modes.includes(text(hints.mode)) ||
        hints.renderer !== "text"
      ) fail("preparation_renderer_unavailable");
      const input: PreparationInput = {
        parent: parentReference(value.parent),
        preparation,
        operationKey: text(value.operationKey),
        recordId: text(value.recordId),
        actionId: registered.actionId,
        source: registered.source,
        hints: { mode: String(hints.mode), renderer: "text" },
      };
      const intent = await ownerPreparationIntent({
        preparation,
        operationKey: input.operationKey,
        parentOperationKey: input.parent.operationKey,
        source: input.source,
        recordId: input.recordId,
        actionId: input.actionId,
        hints: input.hints,
      });
      return {
        value: input,
        intent,
      };
    },
  };
  async function checkCapture(
    tx: SqlExecutor,
    caller: OwnerCaller,
    capture: OwnerPreparationCapture,
    purpose: "capture" | "duplicate" | "input" | "result",
    commandTime: string,
    signal: AbortSignal,
  ) {
    const registered = registrations.get(capture.preparation);
    if (
      !registered || registered.source !== capture.source.source.name ||
      !registered.modes.includes(capture.view.hints.mode)
    ) fail("preparation_forbidden");
    const context = {
      tx,
      caller: structuredClone(caller),
      commandTime,
      signal: AbortSignal.any([signal]),
    };
    await source.authorizeOriginal(
      structuredClone(capture.source),
      context,
      purpose,
    );
    signal.throwIfAborted();
    await registered.resources.authorize(
      tx,
      structuredClone(capture.resources),
      {
        caller: structuredClone(caller),
        scope: {
          namespace: capture.source.source.namespace,
          audience: capture.source.audience,
        },
        commandTime,
        signal,
      },
      purpose,
    );
    signal.throwIfAborted();
  }
  const handler: OwnerCommandHandler = async (_intent, context) => {
    const state = authorized.get(context.tx);
    authorized.delete(context.tx);
    const input = state?.input;
    if (!input || canonical(input) !== canonical(context.input!)) {
      fail("preparation_forbidden");
    }
    const registered = registrations.get(input.preparation)!;
    const captured = structuredClone(
      await source.capture({
        source: input.source,
        recordId: input.recordId,
      }, {
        tx: context.tx,
        caller: structuredClone(context.caller),
        commandTime: context.commandTime,
        signal: AbortSignal.any([context.signal]),
      }),
    );
    context.signal.throwIfAborted();
    if (captured.reference.source.namespace !== state!.namespace) {
      fail("preparation_forbidden");
    }
    const scope = {
      namespace: captured.reference.source.namespace,
      audience: captured.reference.audience,
    };
    const resources = await registered.resources.capture(context.tx, {
      caller: structuredClone(context.caller),
      scope,
      commandTime: context.commandTime,
      signal: context.signal,
    });
    const rendered = await renderer.render({
      shows: registered.shows,
      hints: input.hints,
      data: captured.projection,
      resources: resources.values,
      scope,
      signal: context.signal,
      mapInput: registered.mapInput,
    });
    // Registered mappers are trusted evaluation code, but this capture path
    // accepts only ordinary input. They cannot introduce unsupported protected
    // or content protocols into the child's lifecycle-owned body.
    try {
      assertOwnerOrdinaryValue(rendered.input);
    } catch (error) {
      if (
        error && typeof error === "object" && "code" in error &&
        error.code === "ordinary_value_unsupported"
      ) fail("preparation_unsupported");
      throw error;
    }
    const preparation = parseOwnerPreparationCapture({
      schema: OWNER_PREPARATION_SCHEMA,
      preparation: input.preparation,
      source: captured.reference,
      resources: resources.references,
      view: {
        shows: registered.shows,
        hints: rendered.hints,
        selection: rendered.selection,
      },
    });
    await checkCapture(
      context.tx,
      context.caller,
      preparation,
      "capture",
      context.commandTime,
      context.signal,
    );
    return childReference(
      await children.admitPrepared({
        parent: structuredClone(input.parent),
        actionAlias: registered.actionAlias,
        operationKey: childKey(input.preparation, input.operationKey),
        input: rendered.input,
        preparation: structuredClone(preparation),
      }, {
        ...context,
        caller: structuredClone(context.caller),
        command: { ...context.command },
        input: json(context.input),
        ownerCommit: { ...context.ownerCommit },
        signal: AbortSignal.any([context.signal]),
      }),
    );
  };
  return {
    historyRegistrations(): readonly OwnerPreparationHistoryRegistration[] {
      return [...registrations].map(([name, registration]) => ({
        name,
        source: registration.source,
        actionId: registration.actionId,
        modes: [...registration.modes],
        resources: structuredClone(registration.resourceCoordinates),
      }));
    },
    inputDefinition,
    handler,
    snapshot: renderer.snapshot,
    async authorize(
      tx: SqlExecutor,
      caller: OwnerCaller,
      command: OwnerCommand,
      commandTime: string,
      normalizedInput?: OwnerJson,
    ): Promise<void> {
      authorized.delete(tx);
      if (
        command.kind !== OWNER_CHILD_ACTION_PREPARATION ||
        command.domain !== "logical"
      ) fail();
      const input = exact(normalizedInput, [
        "parent",
        "preparation",
        "operationKey",
        "recordId",
        "actionId",
        "source",
        "hints",
      ]) as PreparationInput;
      const registered = registrations.get(input.preparation);
      if (
        !registered || registered.actionId !== input.actionId ||
        registered.source !== input.source
      ) fail();
      const target = structuredClone(
        await children.authorizePreparedTarget(
          tx,
          structuredClone(caller),
          structuredClone(input.parent),
          registered.actionAlias,
          childKey(input.preparation, input.operationKey),
          commandTime,
          structuredClone(command),
        ),
      );
      if (
        target.actionId !== input.actionId ||
        command.key !==
          ownerPreparationKey(
            ownerId,
            target.parent.namespace,
            target.parent.operationKey,
            input.preparation,
            input.operationKey,
          )
      ) fail("preparation_forbidden");
      const existing =
        (await tx.query<{ kind: string; intent: OwnerJson; result: OwnerJson }>(
          `SELECT kind,intent,result FROM ${tables.receipts} WHERE owner=$1 AND domain='logical' AND key=$2`,
          [ownerId, command.key],
        )).rows[0];
      if (existing) {
        if (
          existing.kind !== command.kind ||
          canonical(existing.intent) !== canonical(command.intent)
        ) fail("owner_intent_conflict");
        const reference = childReference(existing.result);
        if (
          reference.namespace !== target.parent.namespace ||
          reference.actionId !== input.actionId ||
          reference.executionId !==
            `${target.parent.operationKey}/action:${input.actionId}:${
              childKey(input.preparation, input.operationKey)
            }`
        ) fail("preparation_forbidden");
        const original = structuredClone(
          await children.inspectPrepared(
            tx,
            structuredClone(caller),
            structuredClone(input.parent),
            structuredClone(reference),
            commandTime,
          ),
        );
        const capture = preparationCaptureFromMetadata(original.metadata);
        if (
          !capture || capture.preparation !== input.preparation ||
          capture.source.source.namespace !== target.parent.namespace ||
          capture.source.source.name !== input.source ||
          capture.source.source.recordId !== input.recordId ||
          canonical(capture.view.hints) !== canonical(input.hints)
        ) fail("preparation_forbidden");
        await checkCapture(
          tx,
          caller,
          capture,
          "duplicate",
          commandTime,
          new AbortController().signal,
        );
        // Original source/resource permission does not substitute for the live
        // parent assignment. Recheck it after awaited duplicate policy work.
        const final = structuredClone(
          await children.authorizePreparedTarget(
            tx,
            structuredClone(caller),
            structuredClone(input.parent),
            registered.actionAlias,
            childKey(input.preparation, input.operationKey),
            commandTime,
            structuredClone(command),
          ),
        );
        if (
          final.actionId !== target.actionId ||
          final.parent.namespace !== target.parent.namespace ||
          final.parent.operationKey !== target.parent.operationKey ||
          final.parent.source.id !== target.parent.source.id ||
          final.parent.delivery.id !== target.parent.delivery.id
        ) {
          fail("preparation_forbidden");
        }
      }
      authorized.set(tx, { input, namespace: target.parent.namespace });
    },
    async authorizeCaptured(
      tx: SqlExecutor,
      input: OwnerPreparedInputContext,
    ): Promise<void> {
      const context = { ...input, caller: structuredClone(input.caller) };
      const store = readStore(tx);
      const original = await store.getEvent(context.sourceEventId);
      const delivery = await store.getDelivery(context.deliveryId);
      if (
        !original || !delivery || original.ownerId !== ownerId ||
        original.namespace !== context.namespace ||
        original.type !== "copilotz.owner.action.requested" ||
        original.metadata.actionId !== context.actionId ||
        delivery.eventId !== original.id ||
        delivery.consumerId !== `registered:${context.actionId}`
      ) fail("preparation_forbidden");
      const capture = preparationCaptureFromMetadata(original.metadata);
      if (!capture) fail("preparation_forbidden");
      const registered = registrations.get(capture.preparation);
      if (
        !registered || registered.actionId !== context.actionId ||
        capture.source.source.namespace !== context.namespace
      ) fail("preparation_forbidden");
      await checkCapture(
        tx,
        context.caller,
        capture,
        context.purpose === "result" ? "result" : "input",
        context.commandTime,
        context.signal,
      );
    },
  };
}
