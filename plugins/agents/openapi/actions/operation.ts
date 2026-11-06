/**
 * An operation's Action (`<api>.<operation>`): one HTTP call, with the
 * API's settings (base URL, headers, a timeout, a size cap), answered with
 * what the API returned. Recorded, so a retried turn that already called it
 * gets that result back instead of calling the API again. A failure says
 * why: `HTTP <status>: …` (code `http`, with `status`), `timeout`,
 * `unreachable`, or `too_large`.
 */
import { type ActionDef, type Context, failure } from "../../../../runtime/mod.ts";
import type { Plan } from "../shared/plan.ts";
import { build, type Built } from "../shared/request.ts";
import { httpError, isText, readUpTo, resultOf, typeOf } from "../shared/response.ts";
import { type Settings, settingsOf, sized } from "../shared/settings.ts";

/** How much of a failed response is read, for what it says. */
const ERROR_BYTES = 16_000;

const duration = (ms: number) => ms < 1000 ? `${ms} ms` : `${+(ms / 1000).toFixed(1)} s`;

export function operationAction(
  api: string,
  plan: Plan,
  input: Record<string, unknown>,
  description: string,
  server: string | undefined,
): ActionDef {
  return {
    description,
    input,
    run: async (ctx: Context, given: Record<string, unknown>) => {
      const settings = settingsOf(ctx, api);
      const base = settings.baseUrl ?? server;
      if (!base) throw failure("invalid", `No base URL for ${api}: set its baseUrl`);
      const request = build(plan, given, base, settings.query);
      const hook = settings.headers;
      const headers = typeof hook === "function"
        ? await hook(ctx, { operation: plan.id, method: plan.method, url: request.url })
        : hook ?? {};
      for (const [name, value] of Object.entries(headers)) request.headers.set(name, value);
      return await send(ctx, settings, plan, request);
    },
  };
}

/** Makes the call, within the timeout and the caller's signal, and reads what came back. */
async function send(ctx: Context, settings: Settings, plan: Plan, request: Built) {
  const host = new URL(request.url).host;
  const stop = new AbortController();
  let late = false;
  const timer = setTimeout(() => (late = true, stop.abort()), settings.timeout);
  const cancel = () => stop.abort(ctx.signal.reason);
  if (ctx.signal.aborted) cancel();
  else ctx.signal.addEventListener("abort", cancel, { once: true });
  try {
    const response = await ctx.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body !== undefined ? { body: request.body } : {}),
      signal: stop.signal,
    });
    if (!response.ok) {
      const { bytes } = await readUpTo(response, ERROR_BYTES, true);
      throw httpError(response, isText(typeOf(response)) ? resultOf(bytes, response) : null);
    }
    // Text may be as long as `maxBytes`, plus room for the files it holds; a file, a file's room.
    const binary = !isText(typeOf(response));
    const files = settings.files?.[plan.id]?.length;
    const limit = binary
      ? settings.maxFileBytes
      : settings.maxBytes + (files ? Math.ceil(settings.maxFileBytes * 4 / 3) + 1024 : 0);
    const { bytes, over } = await readUpTo(response, limit);
    if (over) {
      const cap = `${sized(limit)} (its ${binary ? "maxFileBytes" : "maxBytes"})`;
      throw failure(
        "too_large",
        `The response to ${plan.method} ${plan.path} is larger than ${cap}: ask for less, ` +
          "such as a filter or a smaller page",
      );
    }
    return resultOf(bytes, response);
  } catch (error) {
    if (ctx.signal.aborted) throw ctx.signal.reason ?? error;
    if (late) {
      throw failure("timeout", `No response from ${host} within ${duration(settings.timeout)}`);
    }
    if (typeof (error as { code?: unknown }).code === "string") throw error;
    throw failure("unreachable", `Couldn't reach ${host}: ${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", cancel);
  }
}
