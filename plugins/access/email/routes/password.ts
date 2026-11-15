/**
 * Password sign-in on the web, each step a route calling its Action, with
 * who calls (`address`) for the limits (see shared/step.ts):
 *
 * - `GET /signin/password`: it's here (`{}`), for the page to offer it;
 * - `POST /signin/password` `{ identifier, password }`: signed in;
 * - `POST /signin/password/change` `{ password, new }`: a person signed in
 *   changes theirs, and is signed in again (their other sessions end).
 */
import type { Route } from "../../../../runtime/mod.ts";
import { json, step } from "../shared/step.ts";

const signIn = step("password.sign-in", ["identifier", "password"], { signs: true });

/** `GET /signin/password` (it's here), `POST` signs in. */
export const passwordRoute: Route = (request, ctx) =>
  request.method === "GET" || request.method === "HEAD" ? json({}) : signIn(request, ctx);

export const passwordChangeRoute: Route = step("password.change", ["password", "new"], {
  signs: true,
  person: true,
});
