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
 * Signed in, a route sets the session's cookie (identity's `signedIn`);
 * refusals are said as shared/step.ts says.
 */
import type { Route } from "../../../../runtime/mod.ts";
import { json, step } from "../shared/step.ts";
import { signInOf } from "../shared/settings.ts";

const signInStep = step("email.sign-in", ["email", "password"], { signs: true });

/** `GET /signin/email` (it's here: whether people make accounts), `POST` signs in. */
export const signInRoute: Route = (request, ctx) => {
  if (request.method === "GET" || request.method === "HEAD") {
    const settings = signInOf({ resources: ctx.runtime.describe().resources });
    return json({ signUp: settings.signUp !== false });
  }
  return signInStep(request, ctx);
};

export const signUpRoute: Route = step("email.sign-up", ["email", "password", "name"]);
export const verifyRoute: Route = step("email.verify", ["email", "code"], { signs: true });
export const forgotRoute: Route = step("email.forgot", ["email"]);
export const resetRoute: Route = step("email.reset", ["email", "code", "password"], {
  signs: true,
});
export const invitationRoute: Route = step("email.invitation", ["token"]);
export const acceptRoute: Route = step("email.accept", ["token", "password", "name"], {
  signs: true,
});
