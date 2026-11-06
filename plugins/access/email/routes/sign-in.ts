/**
 * Email sign-in on the web, each step a route calling its Action as the
 * system, with who calls (`address`: the app's front's word for it, the
 * `caller` resource, else the socket's) for the limits:
 *
 * - `GET /signin/email`: it's here (`{ signUp }`: whether people make
 *   accounts themselves), for the page to offer it;
 * - `POST /signin/email` `{ email, password }`: signed in;
 * - `POST /signin/email/sign-up` `{ email, password, name? }`: a code sent;
 * - `POST /signin/email/verify` `{ email, code }`: signed in;
 * - `POST /signin/email/forgot` `{ email }`: a code sent, if it's someone's;
 * - `POST /signin/email/reset` `{ email, code, password }`: signed in;
 * - `POST /signin/email/invitation` `{ token }`: the address a link is for;
 * - `POST /signin/email/accept` `{ token, password, name? }`: signed in.
 *
 * Signed in, a route sets the session's cookie (identity's `signedIn`). A
 * refusal answers `{ error, code }`, the page's to show and act on:
 * `invalid` (400), `unauthorized` (401), `unverified` (403: ask for the
 * code), `forbidden` (403), `too_many` (429, with `retry-after`), and
 * `unavailable` (503: an email that didn't go).
 */
import {
  callerFrom,
  callerOf,
  clientAddress,
  countedOf,
  failure,
  isPublic,
  jsonOf,
  privateAddress,
  type Resources,
  type Route,
  type RouteContext,
} from "../../../../runtime/mod.ts";
import { signedIn } from "../../identity/contract.ts";
import type { SignedInByEmail } from "../contract.ts";
import { signInOf } from "../shared/settings.ts";

/** A refusal's status, by its code. */
const STATUS: Record<string, number> = {
  invalid: 400,
  unauthorized: 401,
  unverified: 403,
  forbidden: 403,
  not_found: 404,
  too_many: 429,
  unavailable: 503,
};

/** What a route answers in JSON is someone's: never kept. */
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

/** The runtimes already told their callers all come from one private address. */
const told = new WeakSet<object>();

/**
 * Who calls, as the limits count them: the app's front's word (refused
 * around it), else the socket's address; `unknown` when neither says, all
 * such callers counted as one. A socket's private address is a proxy's, not
 * a caller's: said once, since every caller is then one.
 */
function callerIn(request: Request, runtime: object, resources: Resources): string {
  const caller = callerOf({ resources });
  if (caller) {
    const said = callerFrom(request, caller);
    if (said === "refused") {
      throw failure("forbidden", "Not through the app's front.", { public: true });
    }
    return said?.counted ?? "unknown";
  }
  const seen = clientAddress(request);
  if (seen && privateAddress(seen) && !told.has(runtime)) {
    told.add(runtime);
    console.warn(
      `email-sign-in: callers come from ${seen}, a private address: a proxy's before the app, ` +
        "not theirs, so every caller is counted as one. Say how the app's front names " +
        "callers (the caller resource), unless this is a machine of your own.",
    );
  }
  return (seen && countedOf(seen)) || "unknown";
}

/** The strings a step takes from what was posted (anything else is left out). */
const picked = (asked: Record<string, unknown>, names: string[]) =>
  Object.fromEntries(names.flatMap((n) => typeof asked[n] === "string" ? [[n, asked[n]]] : []));

/**
 * A step: POST only, its fields from a JSON body, who calls added, its Action
 * called; a session it answers set in its cookie; a refusal said with its code.
 */
const step = (action: string, fields: string[], signs = false): Route =>
async (
  request,
  ctx: RouteContext,
) => {
  if (request.method !== "POST") return json({ error: "Only POST" }, 405);
  const asked = await jsonOf(request);
  if (!asked) return json({ error: "Send a JSON object, of 16 KiB at most" }, 400);
  const resources: Resources = ctx.runtime.describe().resources;
  try {
    const address = callerIn(request, ctx.runtime, resources);
    const answer = await ctx.runtime.call<SignedInByEmail & Record<string, unknown>>(
      action,
      { ...picked(asked, fields), address },
    );
    if (signs) return signedIn(ctx.cookies, answer);
    return json(answer);
  } catch (error) {
    const { code } = error as { code?: string };
    if (!isPublic(error) || !code || !STATUS[code]) throw error;
    return json(
      { error: (error as Error).message, code },
      STATUS[code],
      code === "too_many" ? { "retry-after": "900" } : {},
    );
  }
};

/** `GET /signin/email` (it's here: whether people make accounts), `POST` signs in. */
export const signInRoute: Route = (request, ctx) => {
  if (request.method === "GET" || request.method === "HEAD") {
    const settings = signInOf({ resources: ctx.runtime.describe().resources });
    return json({ signUp: settings.signUp !== false });
  }
  return step("email.sign-in", ["email", "password"], true)(request, ctx);
};

export const signUpRoute: Route = step("email.sign-up", ["email", "password", "name"]);
export const verifyRoute: Route = step("email.verify", ["email", "code"], true);
export const forgotRoute: Route = step("email.forgot", ["email"]);
export const resetRoute: Route = step("email.reset", ["email", "code", "password"], true);
export const invitationRoute: Route = step("email.invitation", ["token"]);
export const acceptRoute: Route = step("email.accept", ["token", "password", "name"], true);
