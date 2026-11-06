/**
 * OpenAPI: an HTTP API's operations as Actions and as tools for agents, made
 * from its OpenAPI 3 spec. `openapi({ name, spec })` returns an ordinary
 * plugin with, for each operation:
 *
 * - **an Action**, `<name>.<operationId>`, that makes the call: recorded, so
 *   a turn tried again after a failure gets the result of a call it already
 *   made rather than calling the API twice. Code calls it like any Action
 *   (`ctx.call("trips.getTrip", { tripId })`). A failed call says
 *   `HTTP <status>: <what the API said>` and carries `status`.
 * - **a tool**, `<name>_<operationId>`, that calls that Action. Agents get the
 *   ones they list in their `tools`; one no agent lists stays for code. Its
 *   input is one object: the path, query, header and cookie parameters and
 *   the JSON body's properties side by side (a body that isn't an object is
 *   `body`); its description, the operation's summary and description.
 *
 * Its settings are the `openapi` resource, one entry per API, which an app
 * patches per deployment: `baseUrl` (the spec's first server otherwise),
 * `headers` (static, or a hook computing them for each call: auth), `query`,
 * `timeout` (30 s), `maxBytes` (100 KB: a larger response fails rather than
 * flood a prompt), and `files`: fields holding a file (an image, as a data URL
 * or base64), which a tool keeps as a `file` of the conversation, giving the
 * agent a reference instead (`maxFileBytes`, `fileTypes`). A response that is
 * a file is one too.
 *
 * ```ts
 * const trips = openapi({ name: "trips", spec, files: { getMap: ["image"] } });
 * plugins: [models, chat, trips, definePlugin({
 *   name: "app",
 *   resources: {
 *     openapi: { trips: { baseUrl: "https://api.example.com/v2", headers: { authorization } } },
 *     agents: { planner: { instructions, model, tools: ["trips_listTrips", "trips_getMap"] } },
 *     // A tool of its own, over the same Action.
 *     tools: { trips_getTrip: { ...trips.tools.getTrip, run: (input, ctx) => ctx.call(…) } },
 *   },
 * })]
 * ```
 */
import type { Plugin } from "../../../runtime/mod.ts";
import type { Tool } from "../chat/contract.ts";
import { operationAction } from "./actions/operation.ts";
import { operationTool } from "./resources/tools.ts";
import { planOf } from "./shared/plan.ts";
import { settingsOf } from "./shared/settings.ts";
import { idOf, operationsOf, read, serverOf } from "./shared/spec.ts";
import type { OpenApi, OpenApiOperation, OpenApiOptions } from "./contract.ts";

export * from "./contract.ts";
export { FILE_TYPES } from "./shared/settings.ts";

/** Tool names models take: letters, digits, `_` and `-`, at most 64. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** An API's operations, as a plugin of Actions and tools (see above). */
export function openapi(options: OpenApiOptions): OpenApi {
  const { name, spec, operations: only, ...settings } = options;
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name ?? "")) {
    throw new Error(`An OpenAPI plugin's name is letters, digits, _ and -, not "${name}"`);
  }
  const doc = read(spec);
  const server = serverOf(doc);
  const found = operationsOf(doc);
  const wanted = only && new Set(only.map(idOf));
  for (const id of wanted ?? []) {
    if (!found.some((f) => f.id === id)) throw new Error(`${name}: no operation "${id}"`);
  }

  const actions: Plugin["actions"] = {};
  const tools: Record<string, Tool> = {};
  const byOperation: Record<string, Tool> = {};
  const operations: Record<string, OpenApiOperation> = {};
  const skipped: Record<string, string> = {};
  for (const f of found) {
    if (wanted && !wanted.has(f.id)) continue;
    const planned = planOf(doc, f);
    if ("skip" in planned) {
      if (wanted) throw new Error(`${name}: operation "${f.id}" can't be a tool: ${planned.skip}`);
      skipped[f.id] = planned.skip;
      continue;
    }
    const { plan, input, description } = planned;
    const tool = `${name}_${f.id}`;
    if (!TOOL_NAME.test(tool)) {
      throw new Error(`${name}: the tool "${tool}" has a name longer than models take (64)`);
    }
    actions[`${name}.${f.id}`] = operationAction(name, plan, input, description, server);
    byOperation[f.id] = tools[tool] = operationTool(name, f.id, input, description);
    operations[f.id] = { tool, action: `${name}.${f.id}`, method: plan.method, path: plan.path };
  }

  return {
    name,
    requires: ["chat"],
    actions,
    resources: { tools, openapi: { [name]: settings } },
    // What it calls with is right, so a mistake stops the runtime rather than a call.
    check(merged) {
      const s = settingsOf(merged, name);
      const base = s.baseUrl ?? server ?? "";
      if (!/^https?:$/.test(URL.canParse(base) ? new URL(base).protocol : "")) {
        throw new Error(
          `OpenAPI "${name}": no base URL` + (server ? ` (the spec's server is "${server}")` : "") +
            `: set resources.openapi.${name}.baseUrl`,
        );
      }
      for (const key of ["timeout", "maxBytes", "maxFileBytes"] as const) {
        if (!(s[key] > 0)) throw new Error(`OpenAPI "${name}": ${key} must be a positive number`);
      }
      for (const operation of Object.keys(s.files ?? {})) {
        if (!operations[operation]) {
          throw new Error(
            `OpenAPI "${name}": files names "${operation}", not one of its operations`,
          );
        }
      }
    },
    tools: byOperation,
    operations,
    skipped,
  };
}
