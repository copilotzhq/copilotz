/**
 * Staff's console (platform staff only, by their sign-in or the email they
 * verified; anyone else, a 403):
 *
 * - `GET /console/orgs`: every org, with what each last reported;
 * - `POST /console/orgs/<id>` `{ suspended?, name? }`;
 * - `POST /console/orgs/<id>/move` `{ schema }`: its rows to another schema
 *   (closed first, then opened there on its next use);
 * - `GET /console/orgs/<id>/export`: its rows, as SQL, to save;
 * - `POST /console/orgs/<id>/delete` `{ confirm: <its name> }`: closed, its
 *   rows dropped, and it's forgotten.
 *
 * The rows' part is the app's (`operations` in the directory's settings);
 * without it, a 501. Gift codes: `GET /console/codes`; `POST /console/codes`
 * `{ amount, expires?, until?, note? }` (the code, shown this once); `POST
 * /console/codes/revoke` `{ id }`.
 */
import { failure, type Route, type RouteContext } from "copilotz";
import { personIn, profileOf } from "../shared/enter.ts";
import { json, orgsOf } from "../shared/http.ts";
import { type OrgInfo, settingsOf } from "../shared/settings.ts";
import { forget } from "../shared/state.ts";

/** The staff member the directory's session is, or a 403. */
async function staffOnly(ctx: Pick<RouteContext, "runtime" | "actor">): Promise<string> {
  if (ctx.actor.kind !== "person") throw failure("forbidden", "Staff only", { public: true });
  const person = personIn(ctx);
  const email = (await profileOf(ctx.runtime, person))?.email;
  const { staff } = await ctx.runtime.call<{ staff: boolean }>("org.mine", {
    person,
    ...(email ? { email } : {}),
  });
  if (!staff) throw failure("forbidden", "Staff only", { public: true });
  return person;
}

const body = async (request: Request) =>
  await request.json().catch(() => ({})) as Record<string, unknown>;

/** `GET /console/orgs`. */
export const consoleOrgsRoute: Route = async (request, ctx) => {
  if (request.method !== "GET") return json({ error: "Only GET" }, 405);
  await staffOnly(ctx);
  return json(await ctx.runtime.call("org.list", {}));
};

/** `/console/orgs/<id>` and `/console/orgs/<id>/<what>`: staff's operations on an org. */
export const operateRoute: Route = async (request, ctx) => {
  await staffOnly(ctx);
  const { runtime, params } = ctx;
  const resources = runtime.describe().resources;
  const org = decodeURIComponent(params.org);
  const what = params.what ? decodeURIComponent(params.what) : "";
  const info = await runtime.query<OrgInfo | null>("org.info", { org });
  if (!info) return json({ error: "No such org" }, 404);
  const ops = settingsOf({ resources }).operations ?? {};
  if (request.method === "GET" && what === "export") {
    if (!ops.export) return json({ error: "This app doesn't export orgs" }, 501);
    return new Response(await ops.export(info), {
      headers: {
        "content-type": "application/sql; charset=utf-8",
        "content-disposition": `attachment; filename="${info.id}.sql"`,
        "cache-control": "no-store",
      },
    });
  }
  if (request.method !== "POST") return json({ error: "Not found" }, 404);
  const asked = await body(request) as {
    suspended?: unknown;
    name?: unknown;
    schema?: unknown;
    confirm?: unknown;
  };
  switch (what) {
    case "": {
      if (typeof asked.suspended === "boolean") {
        await runtime.call("org.suspend", { org: info.id, suspended: asked.suspended });
      }
      if (typeof asked.name === "string" && asked.name.trim()) {
        await runtime.call("org.rename", { org: info.id, name: asked.name.trim() });
      }
      forget(resources, { org: info.id });
      return json({ org: info.id });
    }
    case "move": {
      if (!ops.move) return json({ error: "This app doesn't move orgs" }, 501);
      const to = { schema: String(asked.schema ?? "").trim() };
      if (!/^[a-z][a-z0-9_]{0,62}$/.test(to.schema)) {
        return json({ error: "A schema name (lowercase letters, digits, _)" }, 400);
      }
      if (to.schema === info.placement.schema) return json({ org: info.id, placement: to });
      // Nothing writes while its rows move: it opens again where they went.
      await orgsOf(runtime).close(info.id);
      await ops.move(info, to);
      await runtime.call("org.place", { org: info.id, placement: to });
      forget(resources, { org: info.id });
      return json({ org: info.id, placement: to });
    }
    case "delete": {
      if (!ops.drop) return json({ error: "This app doesn't delete orgs" }, 501);
      // Typing its name confirms it: nothing of it is kept.
      if (asked.confirm !== info.name) {
        return json({ error: "Type the org's name to delete it" }, 400);
      }
      await orgsOf(runtime).close(info.id);
      await ops.drop(info);
      await runtime.call("org.delete", { org: info.id });
      forget(resources, { org: info.id });
      return json({ deleted: info.id });
    }
  }
  return json({ error: "Not found" }, 404);
};

/** `GET /console/codes` and `POST /console/codes`. */
export const codesRoute: Route = async (request, ctx) => {
  const person = await staffOnly(ctx);
  if (request.method === "GET") return json(await ctx.runtime.call("code.list", {}));
  if (request.method !== "POST") return json({ error: "Only GET and POST" }, 405);
  return await ctx.runtime.call("code.create", { ...await body(request), by: person }).then(
    (made) => json(made),
    (error) => json({ error: (error as Error).message }, 400),
  );
};

/** `POST /console/codes/revoke` `{ id }`. */
export const revokeCodeRoute: Route = async (request, ctx) => {
  if (request.method !== "POST") return json({ error: "Only POST" }, 405);
  await staffOnly(ctx);
  const { id } = await body(request);
  return await ctx.runtime.call("code.revoke", { id }).then(
    () => json({}),
    (error) => json({ error: (error as Error).message }, 400),
  );
};
