/**
 * Many orgs behind one address (see design/tenancy.md). A directory runtime
 * signs people in and knows which orgs they belong to; each org is a runtime
 * of its own, opened on its first request and closed when nobody's used it
 * for a while. A browser holds a directory session (`dir`), a session for
 * each org it has entered (`s_<org>`), and which org it's in (`org`), which
 * the switcher changes. Everything an org serves (its page, code, socket,
 * files, plugins' routes) is its own web host's (`hosts/web`), as one app.
 *
 * - `POST /signin/google` `{ idToken }`, `POST /signin/dev` `{ name }` (this
 *   machine only, when `dev`): signs in at the directory, makes the person's
 *   personal org the first time, and enters the org they were in last.
 * - `GET /orgs`: who's signed in, the org they're in, the orgs they belong
 *   to, the invitations waiting for them, and whether they're staff.
 * - `POST /orgs` `{ name }`: makes a team org, its maker its owner, and
 *   enters it. `POST /orgs/enter` `{ org }`: goes into another.
 * - `POST /orgs/invites/answer` `{ invite, accept }`: joins (and enters) or
 *   declines.
 * - `POST /signout`: out of the directory and every org.
 * - `/o/<org>/…`: that org, by its address, for what reaches it without a
 *   browser's session: its API (a key), its webhooks (signed), its
 *   computers' downloads. The org's own handlers say who may.
 * - `/o/<org>/oxian`: that org's socket, for its pages and its computers
 *   (a ticket or a computer's credentials say who); no cookie needed.
 * - Staff's console: `GET /console/orgs`; `POST /console/orgs/<id>`
 *   `{ suspended?, name? }`; `POST …/<id>/move` `{ schema }` (its rows to
 *   another schema); `GET …/<id>/export` (its rows, as SQL); `POST
 *   …/<id>/delete` `{ confirm: <its name> }`. The app does the rows'
 *   part (`operations`). Staff enter any org with `/orgs/enter`. Gift codes:
 *   `GET /console/codes`; `POST /console/codes` `{ amount, expires?, until?,
 *   note? }` (the code, shown this once); `POST /console/codes/revoke` `{ id }`.
 * - Hosts orgs claimed (`claimHost` in an org's `directory` resource: a
 *   preview's `<id>-preview.copilotz.app`, an app's): with the app's own
 *   hosts named (`hosts`), a request to any other host is the org's that
 *   claimed it, answered by its runtime's routes by host alone (never its
 *   page or socket); a host nobody claimed is a 404. Which org a host is
 *   kept a minute, forgotten here as soon as an org claims or releases it.
 * - `GET /__copilotz/hosts/resolve?host=<h>`: whose a host is, `{ org,
 *   target? }` (or 404), for the app's front only (it carries `front`'s
 *   secret): the front sends a host with a target (an app's service)
 *   straight there.
 *
 * Behind a front (a Cloudflare worker), `front: { secret }`: a request
 * carrying the secret (`x-copilotz-front`) is for the host it forwards
 * (`x-forwarded-host`); any other's forwarded headers are ignored.
 *
 * The app says how to open an org: its store (at the org's placement, as
 * its tenant), its plugins with the host's `here` (the org's name, and how
 * it reaches the directory), and `admit` for its browsers.
 */
import type { Actor, Plugins, Runtime, Transport } from "../../runtime/mod.ts";
import { definePlugin } from "../../runtime/mod.ts";
import { createTickets, type Tickets } from "../web/tickets.ts";
import {
  type Code,
  cookieOf,
  setCookie,
  socket,
  webServer,
  type WebServerOptions,
} from "../web/server.ts";
import { hostMatches, hostOf, hostServer, vouched } from "../web/routes.ts";

/** An org as the host opens it. */
export type OrgInfo = {
  id: string;
  name: string;
  kind: "personal" | "team";
  placement: { schema: string };
};

export type OrgsHostOptions =
  & Pick<WebServerOptions, "title" | "theme" | "google" | "dev" | "assets" | "front">
  & {
    /**
     * The app's own hosts (`compass.copilotz.com`; patterns as routes' are,
     * `*.run.app`): a request to any other is for a host an org claimed.
     * Unset, every host is the app's, and claims route nothing.
     */
    hosts?: string[];
    /** The directory's runtime: identity, a sign-in method, and the directory plugin. */
    directory: Runtime;
    /**
     * Opens an org: the app's runtime for it, with these plugins too, this
     * `admit`, and these `transports` (its socket, at `/oxian` and at its
     * address, `/o/<org>/oxian`).
     */
    open(
      org: OrgInfo,
      given: {
        plugins: Plugins;
        admit: (ticket: string) => Actor | undefined;
        transports: Transport[];
      },
    ): Promise<Runtime>;
    /** The socket upgrade for an org's runtime (its transport for browsers). */
    upgrade(runtime: Runtime, request: Request): Response | Promise<Response>;
    code: Code | (() => Code | Promise<Code>);
    /** How long an org nobody uses stays open (30 minutes by default). */
    idleMs?: number;
    /**
     * What staff may do to an org's rows, the app's (its stores know where
     * they live): move them to another placement, export them, drop them.
     * The host closes the org first where it must, and tells the directory.
     */
    operations?: {
      move?(org: OrgInfo, to: OrgInfo["placement"]): Promise<void>;
      export?(org: OrgInfo): ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>;
      drop?(org: OrgInfo): Promise<void>;
    };
  };

type Cell = {
  org: OrgInfo;
  runtime: Runtime;
  tickets: Tickets;
  serve: (request: Request) => Promise<Response>;
  /** Its routes by host alone, for a host it claimed. */
  hosted: (request: Request) => Promise<Response> | undefined;
  last: number;
};

/** Whose a claimed host is, and where the front sends it. */
type Claim = { org: string; target?: string };

/** How long which org a host is stays known here (claims and releases here forget it at once). */
const CLAIMS_MS = 60_000;

/** Where the front asks whose a host is. */
const RESOLVE = "/__copilotz/hosts/resolve";

const DIRECTORY = "dir";
const CURRENT = "org";
const MONTH = 30 * 86_400;
const sessionOf = (org: string) => `s_${org}`;
/** Where an org is reached by its address: `/o/<org>`. */
const baseOf = (org: string) => `/o/${encodeURIComponent(org)}`;
/**
 * Where a page's or a computer's socket reaches an org: under its address
 * (`/o/<org>/oxian`), which names it without cookies (Safari sends none with
 * a socket). Its runtime takes sockets there and at `/oxian` (`given.transports`).
 */
const socketOf = (org: string) => `${baseOf(org)}${socket.config.path}`;
/** The org a path addresses (`/o/<org>/…`), and the path within it. */
const addressed = (path: string) => {
  const found = /^\/o\/([^/]+)(\/.*)?$/.exec(path);
  return found ? { org: decodeURIComponent(found[1]), path: found[2] ?? "/" } : undefined;
};

const json = (value: unknown, init: ResponseInit & { cookies?: string[] } = {}) => {
  const headers = new Headers({ "content-type": "application/json" });
  for (const cookie of init.cookies ?? []) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(value), { status: init.status ?? 200, headers });
};

const loopback = (url: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

/** A request with these cookies set too, as the org's web host will read them. */
const withCookies = (request: Request, cookies: Record<string, string>) => {
  const kept = (request.headers.get("cookie") ?? "").split(/;\s*/).filter((c) =>
    c && !Object.keys(cookies).some((name) => c.startsWith(`${name}=`))
  );
  const headers = new Headers(request.headers);
  headers.set(
    "cookie",
    [...kept, ...Object.entries(cookies).map(([n, v]) => `${n}=${v}`)].join("; "),
  );
  return new Request(request, { headers });
};

/** The orgs host: its request handler, and what an app reaches of the orgs it has open. */
export type OrgsHost = {
  serve(request: Request): Promise<Response>;
  openRuntime(request: Request): Runtime | undefined;
  runtime(org: string): Promise<Runtime | undefined>;
  close(): Promise<void>;
};

export function orgsHost(options: OrgsHostOptions): OrgsHost {
  const { directory } = options;
  const idleMs = options.idleMs ?? 30 * 60_000;
  const cells = new Map<string, Promise<Cell>>();
  /** The cells open now, for what must find one at once (a socket upgrade on Node). */
  const live = new Map<string, Cell>();

  /** Whether a host is the app's own (every host is, when the app names none). */
  const own = (host: string) =>
    !options.hosts || options.hosts.some((pattern) => hostMatches(pattern, host));

  /** Which org each host is, as the directory says, kept a minute: every request asks. */
  const claims = new Map<string, { claim: Promise<Claim | null>; until: number }>();
  const claimOf = (host: string) => {
    const kept = claims.get(host);
    if (kept && kept.until > Date.now()) return kept.claim;
    const claim = directory.query<Claim | null>("orgHost.resolve", { host });
    claims.set(host, { claim, until: Date.now() + CLAIMS_MS });
    claim.catch(() => claims.delete(host));
    return claim;
  };
  /** A host as claims keep it: lowercase, no trailing dot. */
  const plainHost = (host: string) => String(host ?? "").trim().toLowerCase().replace(/\.$/, "");

  /** What an org reaches of the directory: invitations, who leaves, and the hosts it claims. */
  const here = (org: OrgInfo) =>
    definePlugin({
      name: "org-here",
      resources: {
        org: { id: org.id, name: org.name, kind: org.kind, base: baseOf(org.id) },
        directory: {
          invite: (invite: { email: string; role: string; by: string; from?: string }) =>
            directory.call("invite.send", { org: org.id, ...invite }).then(() => {}),
          invites: () =>
            directory.call<{ invites: unknown[] }>("invite.org", { org: org.id }).then((r) =>
              r.invites
            ),
          cancel: (email: string) =>
            directory.call("invite.cancel", { org: org.id, email }).then(() => {}),
          leave: (person: string) =>
            directory.call("org.leave", { org: org.id, person }).then(() => {}),
          rename: (name: string) =>
            directory.call("org.rename", { org: org.id, name }).then(() => {
              known.delete(org.id);
            }),
          /**
           * Makes a host the org's: its requests are its routes' by host (a
           * preview's), or, with a `target`, the front sends them there (an
           * app's service). Refused for the app's own hosts, and another org's.
           */
          claimHost: async (host: string, claim: { target?: string } = {}) => {
            const name = plainHost(host);
            if (options.hosts && own(name)) {
              throw Object.assign(new Error(`${name} is the app's own`), { code: "forbidden" });
            }
            await directory.call("host.claim", {
              org: org.id,
              host: name,
              ...(claim.target ? { target: claim.target } : {}),
            });
            claims.delete(name);
          },
          /** A gift code's credits, for this org. */
          claimCode: (code: string, person: string) =>
            directory.call<{ id: string; amount: number; expires?: string; note?: string }>(
              "code.claim",
              { code, org: org.id, person },
            ),
          /** The host is no longer the org's. */
          releaseHost: async (host: string) => {
            const name = plainHost(host);
            await directory.call("host.release", { org: org.id, host: name });
            claims.delete(name);
          },
        },
      },
    });

  /** An org's cell: opened once, on its first request. */
  const cellOf = (org: OrgInfo): Promise<Cell> => {
    let cell = cells.get(org.id);
    if (!cell) {
      cell = (async () => {
        const tickets = createTickets();
        const runtime = await options.open(org, {
          plugins: [here(org)],
          admit: tickets.admit,
          transports: [socket, { type: "websocket", config: { path: socketOf(org.id) } }],
        });
        const serve = webServer({
          runtime,
          tickets,
          code: options.code,
          upgrade: (request) => options.upgrade(runtime, request),
          ...(options.title ? { title: options.title } : {}),
          ...(options.theme ? { theme: options.theme } : {}),
          ...(options.google ? { google: options.google } : {}),
          ...(options.dev ? { dev: options.dev } : {}),
          ...(options.assets ? { assets: options.assets } : {}),
          ...(options.front ? { front: options.front } : {}),
          cookie: sessionOf(org.id),
          signIn: false,
          base: baseOf(org.id),
          socket: socketOf(org.id),
        });
        const hosted = hostServer(
          runtime,
          async (request) => {
            const secret = cookieOf(request, sessionOf(org.id));
            return secret
              ? await runtime.query<Actor | null>("credential.actor", { secret })
              : null;
          },
          options.front ? { front: options.front } : {},
        );
        const made = { org, runtime, tickets, serve, hosted, last: Date.now() };
        live.set(org.id, made);
        return made;
      })();
      cells.set(org.id, cell);
      cell.catch(() => cells.delete(org.id));
    }
    return cell;
  };

  /** Orgs as the directory has them, kept a little while: requests ask for them often. */
  const known = new Map<
    string,
    { info: Promise<(OrgInfo & { suspended?: true }) | null>; until: number }
  >();
  const orgInfo = (org: string) => {
    const kept = known.get(org);
    if (kept && kept.until > Date.now()) return kept.info;
    const info = directory.call<(OrgInfo & { suspended?: true }) | null>("org.get", { org });
    known.set(org, { info, until: Date.now() + 10_000 });
    return info;
  };

  /** Who the directory session signs in, with what they verified. */
  const signedIn = async (request: Request) => {
    const secret = cookieOf(request, DIRECTORY);
    if (!secret) return null;
    const actor = await directory.query<Actor | null>("credential.actor", { secret });
    if (!actor) return null;
    const { email } = await directory.call<{ email: string | null }>("person.email", {
      person: actor.id,
    });
    return { person: actor.id, email };
  };

  /** Goes into an org: the directory lets them in; the org knows them, and gives them a session. */
  const enter = async (
    request: Request,
    url: URL,
    who: { person: string; email: string | null },
    org: string,
  ) => {
    const { org: info, role, staff } = await directory.call<
      { org: OrgInfo; role?: string; staff: boolean }
    >("org.enter", { org, person: who.person, ...(who.email ? { email: who.email } : {}) });
    const cell = await cellOf(info);
    cell.last = Date.now();
    report(cell);
    const profile = await directory.query<{ name?: string; picture?: string } | null>(
      "person.profile",
      { person: who.person },
    ).catch(() => null);
    await cell.runtime.call("person.set", {
      person: who.person,
      ...(who.email ? { email: who.email } : {}),
      ...(profile?.name ? { name: profile.name } : {}),
      ...(profile?.picture ? { picture: profile.picture } : {}),
    });
    if (!staff) {
      await cell.runtime.call("org.join", { person: who.person, ...(role ? { role } : {}) });
    }
    // A session they hold already, for this org and this person, stays.
    const held = cookieOf(request, sessionOf(info.id));
    const kept = held
      ? await cell.runtime.query<Actor | null>("credential.actor", { secret: held })
      : null;
    const session = kept?.id === who.person && (kept.staff === true) === staff
      ? held!
      : (await cell.runtime.call<{ session: string }>("session.start", {
        person: who.person,
        ...(staff ? { staff: true } : {}),
      })).session;
    return {
      org: info,
      session,
      cookies: [
        setCookie(url, session, MONTH, sessionOf(info.id)),
        setCookie(url, info.id, MONTH, CURRENT),
      ],
    };
  };

  /** Whether a request's session for an org's cell is still good there. */
  const heldIn = async (cell: Cell, request: Request) => {
    const secret = cookieOf(request, sessionOf(cell.org.id));
    return !!secret && !!await cell.runtime.query("credential.actor", { secret }).catch(() => null);
  };

  /** The org someone goes back to: the one they were in last (not `not`), or their personal one. */
  const landing = async (person: string, name: string, not?: string) => {
    const { orgs } = await directory.call<
      { orgs: { id: string; kind: string; suspended?: true }[] }
    >("org.mine", { person });
    const open = orgs.filter((o) => o.id !== not && !o.suspended);
    if (open.length) return open[0].id;
    const { org } = await directory.call<{ org: string }>("org.create", {
      name,
      kind: "personal",
      by: person,
    });
    return org;
  };

  const signIn = async (request: Request, url: URL, person: string, session: string) => {
    const who = {
      person,
      email: (await directory.call<{ email: string | null }>("person.email", {
        person,
      })).email,
    };
    const profile = await directory.query<{ name?: string } | null>("person.profile", { person })
      .catch(() => null);
    const org = await landing(person, profile?.name ?? who.email ?? person);
    const entered = await enter(request, url, who, org);
    return json({ person, org: entered.org }, {
      cookies: [setCookie(url, session, MONTH, DIRECTORY), ...entered.cookies],
    });
  };

  /** The lobby: the page before anyone's signed in (it shows sign-in). */
  const lobby = webServer({
    runtime: directory,
    tickets: createTickets(),
    code: options.code,
    upgrade: () => new Response("Sign in first", { status: 401 }),
    ...(options.title ? { title: options.title } : {}),
    ...(options.theme ? { theme: options.theme } : {}),
    ...(options.google ? { google: options.google } : {}),
    ...(options.dev ? { dev: options.dev } : {}),
    ...(options.assets ? { assets: options.assets } : {}),
    cookie: "none",
    signIn: false,
  });

  /** Tells the directory how an org is (its people, spaces, when it was last used). */
  const report = (cell: Cell) =>
    cell.runtime.call<{ people: number; spaces: number }>("org.summary").then((summary) =>
      directory.call("org.report", {
        org: cell.org.id,
        ...summary,
        active: new Date(cell.last).toISOString(),
      })
    ).catch(() => {});

  /** Closes orgs nobody has used for a while, and reports how they are to the directory. */
  const sweep = setInterval(async () => {
    const now = Date.now();
    for (const [id, pending] of cells) {
      const cell = await pending.catch(() => undefined);
      if (!cell) continue;
      await report(cell);
      const stats = cell.runtime.stats();
      if (now - cell.last > idleMs && stats.browsers === 0 && stats.pending === 0) {
        cells.delete(id);
        live.delete(id);
        await cell.runtime.close().catch(() => {});
      }
    }
  }, Math.min(idleMs, 60_000));
  (sweep as { unref?: () => void }).unref?.();

  const staffOnly = async (request: Request) => {
    const who = await signedIn(request);
    if (!who) return null;
    const { staff } = await directory.call<{ staff: boolean }>("org.mine", { person: who.person });
    return staff ? who : null;
  };

  /** Stops an org's runtime, so nothing writes while its rows move or go. */
  const closeCell = async (org: string) => {
    const pending = cells.get(org);
    cells.delete(org);
    live.delete(org);
    known.delete(org);
    const cell = await pending?.catch(() => undefined);
    await cell?.runtime.close().catch(() => {});
  };

  /** Staff's operations on an org: `/console/orgs/<id>[/move|/export|/delete]`. */
  const operate = async (request: Request, org: OrgInfo, what: string): Promise<Response> => {
    const ops = options.operations ?? {};
    if (request.method === "GET" && what === "export") {
      if (!ops.export) return json({ error: "This app doesn't export orgs" }, { status: 501 });
      return new Response(await ops.export(org), {
        headers: {
          "content-type": "application/sql; charset=utf-8",
          "content-disposition": `attachment; filename="${org.id}.sql"`,
        },
      });
    }
    if (request.method !== "POST") return json({ error: "Not found" }, { status: 404 });
    const body = await request.json().catch(() => ({})) as {
      suspended?: boolean;
      name?: string;
      schema?: string;
      confirm?: string;
    };
    switch (what) {
      case "": {
        if (typeof body.suspended === "boolean") {
          await directory.call("org.suspend", { org: org.id, suspended: body.suspended });
          known.delete(org.id);
        }
        if (typeof body.name === "string" && body.name.trim()) {
          await directory.call("org.rename", { org: org.id, name: body.name.trim() });
          known.delete(org.id);
        }
        return json({ org: org.id });
      }
      case "move": {
        if (!ops.move) return json({ error: "This app doesn't move orgs" }, { status: 501 });
        const to = { schema: String(body.schema ?? "").trim() };
        if (!/^[a-z][a-z0-9_]{0,62}$/.test(to.schema)) {
          return json({ error: "A schema name (lowercase letters, digits, _)" }, { status: 400 });
        }
        if (to.schema === org.placement.schema) return json({ org: org.id, placement: to });
        await closeCell(org.id);
        await ops.move(org, to);
        await directory.call("org.place", { org: org.id, placement: to });
        return json({ org: org.id, placement: to });
      }
      case "delete": {
        if (!ops.drop) return json({ error: "This app doesn't delete orgs" }, { status: 501 });
        // Typing its name confirms it: nothing of it is kept.
        if (body.confirm !== org.name) {
          return json({ error: "Type the org's name to delete it" }, { status: 400 });
        }
        await closeCell(org.id);
        await ops.drop(org);
        await directory.call("org.delete", { org: org.id });
        return json({ deleted: org.id });
      }
    }
    return json({ error: "Not found" }, { status: 404 });
  };

  /** Whose a host is, for the front alone: `{ org, target? }`, or 404. */
  const resolve = async (request: Request, url: URL): Promise<Response> => {
    if (!vouched(request, options.front)) {
      return json({ error: "The front's only" }, { status: 403 });
    }
    const claim = await claimOf(plainHost(url.searchParams.get("host") ?? ""));
    return claim ? json(claim) : json({ error: "Nobody's host" }, { status: 404 });
  };

  /** A request to a host an org claimed: its routes by host answer it, or nothing does. */
  const claimed = async (request: Request, host: string): Promise<Response> => {
    const claim = await claimOf(host);
    const org = claim ? await orgInfo(claim.org) : null;
    if (!org) return json({ error: "Not found" }, { status: 404 });
    if (org.suspended) return json({ error: "This org is suspended." }, { status: 403 });
    const cell = await cellOf(org);
    cell.last = Date.now();
    return await (cell.hosted(request) ?? json({ error: "Not found" }, { status: 404 }));
  };

  const serve = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    try {
      if (request.method === "GET" && url.pathname === RESOLVE) return await resolve(request, url);
      // Another host than the app's: an org's that claimed it, and nothing of the app's.
      const host = hostOf(request, options.front);
      if (!own(host)) return await claimed(request, host);
      const at = addressed(url.pathname);
      if (at) {
        const org = await orgInfo(at.org);
        if (!org) return json({ error: "No such org" }, { status: 404 });
        if (org.suspended) return json({ error: "This org is suspended." }, { status: 403 });
        const cell = await cellOf(org);
        cell.last = Date.now();
        // Its socket, as it came: its runtime takes sockets at this address too.
        if (at.path === socket.config.path) return await options.upgrade(cell.runtime, request);
        const inner = new URL(url);
        inner.pathname = at.path;
        return await cell.serve(new Request(inner, request));
      }
      switch (route) {
        case "POST /signin/google": {
          if (!options.google) break;
          const { idToken } = await request.json() as { idToken: string };
          const { person, session } = await directory.call<{ person: string; session: string }>(
            "google.sign-in",
            { idToken },
          );
          return await signIn(request, url, person, session);
        }
        case "POST /signin/dev": {
          if (!options.dev || !loopback(url)) break;
          const { name } = await request.json() as { name: string };
          const person = String(name ?? "").trim().toLowerCase();
          const email = /^[a-z0-9._+-]{1,64}@[a-z0-9.-]{1,64}$/.test(person);
          if (!email && !/^[a-z0-9._-]{1,40}$/.test(person)) {
            return json({ error: "A name (letters, digits, . _ -) or an email" }, { status: 400 });
          }
          await directory.call("person.set", {
            person,
            ...(email ? { email: person } : {}),
            name: email ? person.split("@")[0] : person,
          });
          const { session } = await directory.call<{ session: string }>("session.start", {
            person,
          });
          return await signIn(request, url, person, session);
        }
        case "GET /orgs": {
          const who = await signedIn(request);
          if (!who) return json({ error: "Not signed in" }, { status: 401 });
          const [{ orgs, staff }, { invites }] = await Promise.all([
            directory.call<{ orgs: unknown[]; staff: boolean }>("org.mine", { person: who.person }),
            who.email
              ? directory.call<{ invites: unknown[] }>("invite.mine", { email: who.email })
              : Promise.resolve({ invites: [] }),
          ]);
          return json({
            person: who.person,
            email: who.email,
            current: cookieOf(request, CURRENT) ?? null,
            orgs,
            invites,
            staff,
          });
        }
        case "POST /orgs": {
          const who = await signedIn(request);
          if (!who) return json({ error: "Not signed in" }, { status: 401 });
          const { name } = await request.json() as { name: string };
          if (!String(name ?? "").trim()) return json({ error: "A name" }, { status: 400 });
          const { org } = await directory.call<{ org: string }>("org.create", {
            name: String(name).trim(),
            kind: "team",
            by: who.person,
          });
          const entered = await enter(request, url, who, org);
          return json({ org: entered.org }, { cookies: entered.cookies });
        }
        case "POST /orgs/enter": {
          const who = await signedIn(request);
          if (!who) return json({ error: "Not signed in" }, { status: 401 });
          const { org } = await request.json() as { org: string };
          const entered = await enter(request, url, who, String(org));
          return json({ org: entered.org }, { cookies: entered.cookies });
        }
        case "POST /orgs/invites/answer": {
          const who = await signedIn(request);
          if (!who?.email) return json({ error: "Not signed in" }, { status: 401 });
          const { invite, accept } = await request.json() as { invite: string; accept: boolean };
          const answered = await directory.call<{ org: string; joined: boolean }>(
            "invite.answer",
            { invite, person: who.person, email: who.email, accept: !!accept },
          );
          if (!answered.joined) return json({ joined: false });
          const entered = await enter(request, url, who, answered.org);
          return json({ joined: true, org: entered.org }, { cookies: entered.cookies });
        }
        case "POST /signout": {
          const secret = cookieOf(request, DIRECTORY);
          const who = await signedIn(request);
          if (secret && who) {
            await directory.call("session.end", { session: secret }, {
              actor: { kind: "person", id: who.person },
            }).catch(() => {});
          }
          const cookies = [setCookie(url, "", 0, DIRECTORY), setCookie(url, "", 0, CURRENT)];
          for (const c of (request.headers.get("cookie") ?? "").split(/;\s*/)) {
            const name = c.split("=")[0];
            if (name.startsWith("s_")) cookies.push(setCookie(url, "", 0, name));
          }
          return json({}, { cookies });
        }
        case "GET /console/orgs": {
          if (!await staffOnly(request)) return json({ error: "Staff only" }, { status: 403 });
          return json(await directory.call("org.list", {}));
        }
        case "GET /console/codes": {
          if (!await staffOnly(request)) return json({ error: "Staff only" }, { status: 403 });
          return json(await directory.call("code.list", {}));
        }
        case "POST /console/codes": {
          const who = await staffOnly(request);
          if (!who) return json({ error: "Staff only" }, { status: 403 });
          const body = await request.json().catch(() => ({})) as Record<string, unknown>;
          return await directory.call("code.create", { ...body, by: who.person }).then(
            (made) => json(made),
            (error) => json({ error: (error as Error).message }, { status: 400 }),
          );
        }
        case "POST /console/codes/revoke": {
          if (!await staffOnly(request)) return json({ error: "Staff only" }, { status: 403 });
          const body = await request.json().catch(() => ({})) as Record<string, unknown>;
          return await directory.call("code.revoke", { id: body.id }).then(
            () => json({}),
            (error) => json({ error: (error as Error).message }, { status: 400 }),
          );
        }
      }
      if (url.pathname.startsWith("/console/orgs/")) {
        if (!await staffOnly(request)) return json({ error: "Staff only" }, { status: 403 });
        const [org, what = ""] = url.pathname.slice("/console/orgs/".length).split("/")
          .map(decodeURIComponent);
        const info = await directory.call<OrgInfo | null>("org.get", { org });
        if (!info) return json({ error: "No such org" }, { status: 404 });
        return await operate(request, info, what);
      }
      if (url.pathname.startsWith("/signin")) return json({ error: "Not found" }, { status: 404 });

      // Anything else is the org they're in, whose own web host checks its session. Without
      // one (signed in, but in no org yet, or its cookie gone), they're entered first.
      let current = cookieOf(request, CURRENT);
      let cookies: string[] = [];
      let forwarded = request;
      if (!current || !cookieOf(request, sessionOf(current))) {
        const who = await signedIn(request);
        if (!who) return await lobby(request);
        const entered = await enter(
          request,
          url,
          who,
          current ?? await landing(who.person, who.email ?? who.person),
        ).catch(async () => await enter(request, url, who, await landing(who.person, who.person)));
        current = entered.org.id;
        cookies = entered.cookies;
        forwarded = withCookies(request, {
          [CURRENT]: entered.org.id,
          [sessionOf(entered.org.id)]: entered.session,
        });
      }
      const org = await orgInfo(current);
      if (!org) return await lobby(request);
      const cell = org.suspended ? undefined : await cellOf(org);
      // A page asked for in an org no longer theirs (suspended, or its session ended: taken
      // out, signed out there) lands them in one that is, rather than on an error.
      const page = request.method === "GET" &&
        /text\/html/.test(request.headers.get("accept") ?? "");
      if (!cell || (page && !cookies.length && !await heldIn(cell, request))) {
        if (!page) return json({ error: "This org is suspended." }, { status: 403 });
        const who = await signedIn(request);
        if (!who) return await lobby(request);
        const elsewhere = await enter(
          request,
          url,
          who,
          org.suspended ? await landing(who.person, who.person, org.id) : org.id,
        )
          .catch(async () =>
            await enter(request, url, who, await landing(who.person, who.person, org.id))
          );
        const headers = new Headers({
          location: url.pathname === "/" ? "/" : url.pathname + url.search,
        });
        for (const cookie of elsewhere.cookies) headers.append("set-cookie", cookie);
        return new Response(null, { status: 302, headers });
      }
      cell.last = Date.now();
      const answered = await cell.serve(forwarded);
      if (!cookies.length) return answered;
      const headers = new Headers(answered.headers);
      for (const cookie of cookies) headers.append("set-cookie", cookie);
      return new Response(answered.body, { status: answered.status, headers });
    } catch (error) {
      const code = (error as { code?: string }).code;
      return json({ error: error instanceof Error ? error.message : String(error) }, {
        status: code === "forbidden" ? 403 : 400,
      });
    }
  };

  return {
    serve,
    /**
     * The runtime of the org a request is in, if it's open now; at once, for
     * hosts whose socket upgrade can't wait (Node's). The page opens its org
     * before its socket connects; one not open yet is a retry for the client.
     */
    openRuntime(request: Request): Runtime | undefined {
      // A host an org claimed has no socket of the app's.
      if (!own(hostOf(request, options.front))) return undefined;
      const named = addressed(new URL(request.url).pathname)?.org;
      const org = named ?? cookieOf(request, CURRENT);
      const cell = org ? live.get(org) : undefined;
      // An org named but closed (a computer connecting first) opens for its retry.
      if (!cell && named) {
        void orgInfo(named).then((info) => {
          if (info && !info.suspended) void cellOf(info).catch(() => {});
        }).catch(() => {});
      }
      if (cell) cell.last = Date.now();
      return cell?.runtime;
    },
    /** An org's runtime, opening it if needed: for the app's own work on an org. */
    runtime: async (org: string) => {
      const info = await orgInfo(org);
      return info ? (await cellOf(info)).runtime : undefined;
    },
    async close() {
      clearInterval(sweep);
      live.clear();
      const open = await Promise.all([...cells.values()].map((c) => c.catch(() => undefined)));
      cells.clear();
      await Promise.all(open.map((cell) => cell?.runtime.close().catch(() => {})));
    },
  };
}
