import {
  assertEquals as deepStrictEqual,
  assertEquals as equal,
  assertRejects as rejects,
  assertThrows as throws,
} from "@std/assert";
import { findPluginBoundaryFailures } from "../../../../../scripts/check-plugin-boundaries.ts";
import { createPluginRegistry } from "@copilotz/copilotz/plugins";
import { defineView } from "@copilotz/copilotz/views";
import { defineContextResource } from "../../../authoring/define-context/index.ts";
import type { CollectedContextContribution } from "../../../shared/contributions.ts";
import { createContextViewRenderer } from "./context-views.ts";
const scope = {
  namespace: "workspace-a",
  agentId: "agent-a",
  participantId: "participant-a",
  threadId: "thread-a",
};
const contribution: CollectedContextContribution = {
  resourceId: "app.customer-context",
  id: "customer-a",
  title: "Customer",
  role: "context",
  content: { type: "json", value: { title: "visible", hidden: "HIDDEN" } },
};
const resource = defineContextResource({
  id: contribution.resourceId,
  type: "context",
  purposes: ["conversation"],
  contribute: () => contribution,
});
function input(signal = new AbortController().signal) {
  return {
    contribution,
    content: contribution.content as { type: "json"; value: unknown },
    scope,
    signal,
  };
}

Deno.test("the private Context View helper uses the unchanged public-import boundary", async () => {
  const root = new URL("../../../../../", import.meta.url);
  const paths = [
    "plugins/core/processors/message-router/agents/context-views.ts",
    "runtime/views/index.ts",
    "runtime/views/definition.ts",
  ];
  const sources = await Promise.all(paths.map(async (path) => ({
    path,
    text: await Deno.readTextFile(new URL(path, root)),
  })));
  const mappings = JSON.parse(
    await Deno.readTextFile(new URL("deno.json", root)),
  );
  deepStrictEqual(findPluginBoundaryFailures(sources, mappings), []);
});

Deno.test("Context View bindings validate registered stable IDs and require host projection", async () => {
  const registry = createPluginRegistry({
    resources: { promptContext: { alias: resource } },
  });
  throws(
    () =>
      createContextViewRenderer({
        registry,
        bindings: {},
        project: undefined as never,
      }),
    TypeError,
    "projection is required",
  );
  for (
    const bindings of [
      { alias: "customer" },
      { missing: "customer" },
      { [resource.id]: { unsupported: "customer" } },
      { [resource.id]: " " },
    ]
  ) {
    throws(
      () =>
        createContextViewRenderer({
          registry,
          bindings: bindings as never,
          project: () => ({}),
        }),
      TypeError,
    );
  }
  const duplicate = createPluginRegistry({
    resources: { promptContext: { one: resource, two: { ...resource } } },
  });
  throws(
    () =>
      createContextViewRenderer({
        registry: duplicate,
        bindings: { [resource.id]: "customer" },
        project: () => ({}),
      }),
    TypeError,
    "one registered Context resource",
  );
  let projections = 0;
  const render = createContextViewRenderer({
    registry,
    bindings: { [resource.id]: "customer" },
    project(request) {
      projections++;
      deepStrictEqual({ ...request.scope }, scope);
      equal(request.reference.shows, "customer");
      // The host explicitly selects plain authorized fields; raw source values
      // never become generic fallback output merely because no View matches.
      return { title: "authorized" };
    },
  });
  equal(await render(input()), '{"title":"authorized"}');
  equal(projections, 1);
  equal(
    await render({
      ...input(),
      contribution: { ...contribution, resourceId: "unbound" },
    }),
    undefined,
  );
  equal(projections, 1);
  const denied = createContextViewRenderer({
    registry,
    bindings: { [resource.id]: "customer" },
    project: () => {
      throw new Error("Current agent is not authorized");
    },
  });
  await rejects(
    () => Promise.resolve(denied(input())),
    Error,
    "not authorized",
  );
});

Deno.test("Context View nested projections share cancellation and expose no read or Action capabilities", async () => {
  let nestedStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    nestedStarted = resolve;
  });
  let nestedSignal: AbortSignal | undefined;
  const registry = createPluginRegistry({
    resources: { promptContext: { customer: resource } },
    views: {
      customer: defineView({
        id: "app.customer",
        shows: "customer",
        renderer: "text",
        modes: ["context"],
        async render(_value, context) {
          deepStrictEqual(Object.keys(context.collections), []);
          deepStrictEqual(Object.keys(context.actions), []);
          return await context.show({
            shows: "nested",
            value: { id: "child" },
          });
        },
      }),
    },
  });
  const render = createContextViewRenderer({
    registry,
    bindings: { [resource.id]: "customer" },
    project(request) {
      deepStrictEqual({ ...request.scope }, scope);
      if (request.reference.shows === "nested") {
        nestedSignal = request.signal;
        nestedStarted();
        return new Promise((_resolve, reject) =>
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            { once: true },
          )
        );
      }
      return { title: "authorized" };
    },
  });
  const controller = new AbortController();
  const rendering = render(input(controller.signal));
  await started;
  controller.abort(new Error("preparation cancelled"));
  await rejects(
    () => Promise.resolve(rendering),
    Error,
    "preparation cancelled",
  );
  equal(nestedSignal?.aborted, true);
});

Deno.test("Context View helper captures trusted projector resources and separate immutable invocation scopes", async () => {
  const held = Promise.withResolvers<{ title: string }>();
  const registry = createPluginRegistry({
    resources: { promptContext: { record: resource } },
    views: {
      record: defineView({
        id: "record.snapshot",
        shows: "customer",
        modes: ["context"],
        renderer: "text",
        render(value: { title: string }, context) {
          return `${value.title}:${context.resources.labels.prefix}:${
            (context.scope as { participantId: string }).participantId
          }`;
        },
      }),
    },
  });
  const options = {
    registry,
    bindings: { [resource.id]: "customer" },
    project: () => held.promise,
    resources: { labels: { prefix: "first" } },
  };
  const render = createContextViewRenderer(options);
  const firstInput = { ...input(), scope: { ...scope } };
  const first = render(firstInput);
  firstInput.scope.participantId = "mutated";
  options.project = () => Promise.resolve({ title: "unapproved" });
  options.resources.labels.prefix = "replaced";
  const second = render({
    ...input(),
    scope: { ...scope, participantId: "other" },
  });
  held.resolve({ title: "authorized" });
  equal(await first, "authorized:first:participant-a");
  equal(await second, "authorized:first:other");
});
