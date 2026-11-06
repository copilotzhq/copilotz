/**
 * Many orgs behind one address, for the tests: a directory runtime (identity,
 * the directory, dev sign-in) whose fetch is the app's, the orgs' runtimes
 * (`runtimes`, each with access, the page and `directory.member`), each org's
 * store kept by its placement (so one closed opens again with its rows), and
 * the lobby (the page, for someone signed in nowhere). And a browser: what
 * responses set, sent back.
 */
import {
  createRuntime,
  definePlugin,
  type Plugin,
  type Runtime,
  type Runtimes,
  runtimes,
  setClientAddress,
  type Store,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { webPage } from "../../../hosts/web/server.ts";
import { access, devSignIn, directory, identity, type OrgInfo } from "../mod.ts";
import type { Operations } from "../directory/mod.ts";

export const BASE = "http://localhost:8800";

/** The page, as every runtime that serves it has it. */
export const page: Plugin = definePlugin({
  name: "page",
  resources: { page: { title: "Orgs", code: { entry: "app.js", files: { "app.js": "" } } } },
});

export type Served = {
  dir: Runtime;
  orgs: Runtimes;
  lobby: Runtime;
  /** Each org opened, with the schema its rows were in. */
  opened: [string, string][];
  close(): Promise<void>;
};

export async function served(options: {
  /** More of the directory's resources (`hosts`, `caller`, its own `directory` settings). */
  resources?: Record<string, Record<string, unknown>>;
  /** More plugins for each org's runtime. */
  plugins?: (org: OrgInfo) => Plugin[];
  /** How an org's runtime is made, in place of the usual (an org that fails to open). */
  open?: (org: OrgInfo, given: Plugin[]) => Promise<Runtime>;
  operations?: Operations;
} = {}): Promise<Served> {
  const opened: [string, string][] = [];
  const stores = new Map<string, Store>();
    const orgs = runtimes(async (id) => {
    const org = await dir.query<OrgInfo | null>("org.info", { org: id });
    if (!org) return undefined;
    opened.push([org.id, org.placement.schema]);
    const given = [...access, webPage, page, ...options.plugins?.(org) ?? []];
    const key = `${org.placement.schema}/${org.id}`;
    if (!stores.has(key)) stores.set(key, memoryStore());
    return options.open
      ? await options.open(org, [...given, directory.member(dir, org)])
      : await createRuntime({
        store: stores.get(key)!,
        plugins: [...given, directory.member(dir, org)],
      });
  });
  const lobby = await createRuntime({ store: memoryStore(), plugins: [webPage, page] });
  const { directory: settings, ...rest } = options.resources ?? {};
  const dir: Runtime = await createRuntime({
    store: memoryStore(),
    plugins: [
      identity,
      directory,
      devSignIn,
      definePlugin({
        name: "settings",
        resources: {
          directory: {
            orgs,
            lobby,
            ...(options.operations ? { operations: options.operations } : {}),
            ...settings,
          },
          ...rest,
        },
      }),
    ],
  });
  return {
    dir,
    orgs,
    lobby,
    opened,
    async close() {
      await orgs.close();
      await dir.close();
      await lobby.close();
    },
  };
}

/** A runtime's fetch, or anything that answers requests as one. */
type Fetch = { fetch(request: Request): Promise<Response> };

/**
 * A browser on this machine (its socket's address: a listener's says so),
 * on the app's page: what responses set, sent back; a redirect not
 * followed. `page` asks for a page as a browser navigating does.
 */
export function browser(app: Fetch, base = BASE) {
  const jar = new Map<string, string>();
  const cookie = () => [...jar].map(([n, v]) => `${n}=${v}`).join("; ");
  const keep = (response: Response) => {
    for (const set of response.headers.getSetCookie()) {
      const [pair] = set.split(";");
      const [name, value] = [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
      if (/Max-Age=0/.test(set)) jar.delete(name);
      else jar.set(name, value);
    }
    return response;
  };
  const send = async (method: string, path: string, body?: unknown, headers = {}) =>
    keep(
      await app.fetch(setClientAddress(
        new Request(base + path, {
          method,
          headers: {
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            cookie: cookie(),
            ...headers,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        "127.0.0.1",
      )),
    );
  const page = async (path = "/") =>
    keep(
      await app.fetch(setClientAddress(
        new Request(base + path, {
          headers: { accept: "text/html", "sec-fetch-mode": "navigate", cookie: cookie() },
        }),
        "127.0.0.1",
      )),
    );
  /**
   * Signs in by name, then the page starts over where the directory lands
   * them (their own org, the first time): the org they're in.
   */
  const signIn = async (name: string) => {
    const signed = await send("POST", "/signin/dev", { name });
    if (!signed.ok) throw new Error(`Couldn't sign in: ${signed.status}`);
    const landed = await page("/");
    await landed.body?.cancel();
    return jar.get("org") ?? jar.get("__Host-org");
  };
  return { send, page, signIn, jar, cookie };
}
