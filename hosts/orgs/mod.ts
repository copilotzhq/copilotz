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
 * - Staff's console: `GET /console/orgs`, and `POST /console/orgs/<id>`
 *   `{ suspended?, name? }`. Staff enter any org with `/orgs/enter`.
 *
 * The app says how to open an org: its store (at the org's placement, as
 * its tenant), its plugins with the host's `here` (the org's name, and how
 * it reaches the directory), and `admit` for its browsers.
 */
import type { Actor, Plugins, Runtime } from "../../runtime/mod.ts";
import { definePlugin } from "../../runtime/mod.ts";
import { createTickets, type Tickets } from "../web/tickets.ts";
import { type Code, cookieOf, setCookie, webServer, type WebServerOptions } from "../web/server.ts";

/** An org as the host opens it. */
export type OrgInfo = {
  id: string;
  name: string;
  kind: "personal" | "team";
  placement: { schema: string };
};

export type OrgsHostOptions =
  & Pick<WebServerOptions, "title" | "theme" | "google" | "dev" | "assets">
  & {
    /** The directory's runtime: identity, a sign-in method, and the directory plugin. */
    directory: Runtime;
    /** Opens an org: the app's runtime for it, with these plugins too and this `admit`. */
    open(
      org: OrgInfo,
      given: { plugins: Plugins; admit: (ticket: string) => Actor | undefined },
    ): Promise<Runtime>;
    /** The socket upgrade for an org's runtime (its transport for browsers). */
    upgrade(runtime: Runtime, request: Request): Response | Promise<Response>;
    code: Code | (() => Code | Promise<Code>);
    /** How long an org nobody uses stays open (30 minutes by default). */
    idleMs?: number;
  };

type Cell = {
  org: OrgInfo;
  runtime: Runtime;
  tickets: Tickets;
  serve: (request: Request) => Promise<Response>;
  last: number;
};

const DIRECTORY = "dir";
const CURRENT = "org";
const MONTH = 30 * 86_400;
const sessionOf = (org: string) => `s_${org}`;

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

export function orgsHost(options: OrgsHostOptions) {
  const { directory } = options;
  const idleMs = options.idleMs ?? 30 * 60_000;
  const cells = new Map<string, Promise<Cell>>();

  /** What an org reaches of the directory: invitations, and who leaves. */
  const here = (org: OrgInfo) =>
    definePlugin({
      name: "org-here",
      resources: {
        org: { id: org.id, name: org.name, kind: org.kind },
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
        },
      },
    });

  /** An org's cell: opened once, on its first request. */
  const cellOf = (org: OrgInfo): Promise<Cell> => {
    let cell = cells.get(org.id);
    if (!cell) {
      cell = (async () => {
        const tickets = createTickets();
        const runtime = await options.open(org, { plugins: [here(org)], admit: tickets.admit });
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
          cookie: sessionOf(org.id),
          signIn: false,
        });
        return { org, runtime, tickets, serve, last: Date.now() };
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

  /** The org someone goes back to: the one they were in last, or their personal one. */
  const landing = async (person: string, name: string) => {
    const { orgs } = await directory.call<{ orgs: { id: string; kind: string }[] }>("org.mine", {
      person,
    });
    if (orgs.length) return orgs[0].id;
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

  /** Closes orgs nobody has used for a while, and reports how they are to the directory. */
  const sweep = setInterval(async () => {
    const now = Date.now();
    for (const [id, pending] of cells) {
      const cell = await pending.catch(() => undefined);
      if (!cell) continue;
      const summary = await cell.runtime.call<{ people: number; spaces: number }>("org.summary")
        .catch(() => undefined);
      if (summary) {
        await directory.call("org.report", {
          org: id,
          ...summary,
          active: new Date(cell.last).toISOString(),
        }).catch(() => {});
      }
      const stats = cell.runtime.stats();
      if (now - cell.last > idleMs && stats.browsers === 0 && stats.pending === 0) {
        cells.delete(id);
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

  const serve = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    try {
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
      }
      if (request.method === "POST" && url.pathname.startsWith("/console/orgs/")) {
        if (!await staffOnly(request)) return json({ error: "Staff only" }, { status: 403 });
        const org = decodeURIComponent(url.pathname.slice("/console/orgs/".length));
        const { suspended, name } = await request.json() as { suspended?: boolean; name?: string };
        if (typeof suspended === "boolean") await directory.call("org.suspend", { org, suspended });
        if (typeof name === "string" && name.trim()) {
          await directory.call("org.rename", { org, name: name.trim() });
        }
        return json({ org });
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
      if (org.suspended) return json({ error: "This org is suspended." }, { status: 403 });
      const cell = await cellOf(org);
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
    /** An org's runtime, opening it if needed: for the app's own work on an org. */
    runtime: async (org: string) => {
      const info = await orgInfo(org);
      return info ? (await cellOf(info)).runtime : undefined;
    },
    async close() {
      clearInterval(sweep);
      const open = await Promise.all([...cells.values()].map((c) => c.catch(() => undefined)));
      cells.clear();
      await Promise.all(open.map((cell) => cell?.runtime.close().catch(() => {})));
    },
  };
}
