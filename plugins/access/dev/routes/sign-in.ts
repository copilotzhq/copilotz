/**
 * `/signin/dev`, from this machine only (`fromHere`): `GET` says it's here
 * (`{}`), for the page to offer it; `POST` `{ name }` signs in by that name
 * (`dev.sign-in`) and sets the session's cookie. From anywhere else, there's
 * no such route: a 404.
 */
import { jsonOf, type Route } from "../../../../runtime/mod.ts";
import { signedIn } from "../../identity/contract.ts";
import { fromHere } from "../shared/here.ts";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export const devSignInRoute: Route = async (request, { runtime, cookies }) => {
  if (!fromHere(request)) return json({ error: "Not found" }, 404);
  if (request.method === "GET") return json({});
  if (request.method !== "POST") return json({ error: "Only GET and POST" }, 405);
  const asked = await jsonOf(request);
  if (!asked) return json({ error: "Send a JSON object, of 16 KiB at most" }, 400);
  return signedIn(cookies, await runtime.call("dev.sign-in", asked));
};
