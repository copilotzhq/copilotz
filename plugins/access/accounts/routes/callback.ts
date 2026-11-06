/**
 * `GET /accounts/callback/<provider>`: where a provider sends the person back
 * after they sign in. Their session says who they are (its cookie is
 * `SameSite=Lax`, so it comes along on the provider's redirect); the code
 * and state go to `account.callback` as plain data. Either way they land on
 * Connected accounts, which says how it went (`?connected=` or
 * `?failed=…&why=`), never kept and with no referrer, so the code goes nowhere.
 */
import type { Route } from "../../../../runtime/mod.ts";

/** A provider's name in the path, as it was meant (one that can't be read is none). */
const named = (part: string) => {
  try {
    return decodeURIComponent(part);
  } catch {
    return "";
  }
};

/** Back to Connected accounts, saying how it went. */
const back = (said: Record<string, string>) =>
  new Response(null, {
    status: 302,
    headers: {
      location: `/accounts?${new URLSearchParams(said)}`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });

export const callbackRoute: Route = async (request, { runtime, actor, params }) => {
  if (request.method !== "GET") {
    return new Response("Only GET", { status: 405, headers: { allow: "GET" } });
  }
  const provider = named(params.provider ?? "");
  if (actor.kind !== "person") return back({ failed: provider, why: "signed_out" });
  const query = new URL(request.url).searchParams;
  const asked = Object.fromEntries(
    ["code", "state", "error"].flatMap((name) => {
      const value = query.get(name);
      return value === null ? [] : [[name, value.slice(0, name === "error" ? 200 : 4096)]];
    }),
  );
  const said = await runtime.call<Record<string, string>>(
    "account.callback",
    { provider: provider.slice(0, 100), ...asked },
    { actor },
  );
  return back(said);
};
