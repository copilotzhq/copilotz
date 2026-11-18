---
title: "Serving on the web"
description: "The runtime answers HTTP itself: runtime.fetch, plugins' routes and who, the page on Node and in the browser, sign-in and its page's words, and apps with no page at all."
section: Guides
order: 1
---

# Serving on the web

The runtime answers HTTP itself, so a host only listens and calls it.

## One fetch handler

`runtime.fetch(request)` takes a web-standard `Request` and returns a `Response`, for every request
the app gets. A host knows no plugin:

```ts
Deno.serve({ port: 8080 }, runtime.fetch); // Deno
const server = await listen(runtime.fetch, { port: 8080 }); // Node and Bun: copilotz/web/node
export default { fetch: runtime.fetch }; // workerd (Cloudflare Workers)
```

What it answers comes from the app's plugins. The same call serves a signed-in workspace, a public
site where visitors chat with an agent, or a WhatsApp app with no page at all:

| Part                                                       | Comes from                                                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `POST /connect`, the socket (`/oxian`), `/api/`, `/health` | the runtime itself                                                                           |
| Webhooks, APIs, sockets of their own                       | plugins' `routes`                                                                            |
| Who a request is (if nobody says, it's anonymous)          | plugins' `who`: identity's sessions, the api plugin's keys, site visitors                    |
| The page and its code (without it, there's no page)        | the page plugin (`webPage`) and the `page` resource                                          |
| Signing in and out (without them, nobody signs in)         | `googleSignIn`, `emailSignIn`, `passwordSignIn`, `devSignIn` (this machine), `POST /signout` |

## Routes

A route is a plain function on a plugin, keyed by a URL pattern. Routes deal with HTTP, and Actions
do the work, given plain data:

```ts
import { defineAction, definePlugin, type Route } from "copilotz";

const ping: Route = async (request, { runtime }) => {
  if (request.method !== "POST") return new Response("Only POST", { status: 405 });
  return Response.json(await runtime.call("relay.ping", { body: await request.text() }));
};

const relay = definePlugin({
  name: "relay",
  actions: {
    "relay.ping": defineAction({
      input: { type: "object", properties: { body: { type: "string" } } },
      run: (_ctx, input) => ({ pong: input.body ?? null }),
    }),
  },
  routes: { "/hooks/ping": ping },
});
```

A route gets the request as the browser sent it, on the site it asked for. The app's base is taken
off its path: under an org's `/o/acme`, the path `/o/acme/x` is `/x` (the `page.base` resource).

Beside the request, a route gets 4 things:

- `runtime`, the runtime as trusted code. What it calls runs as the system, or as the actor it
  names.
- `actor`, who the request is.
- `params`, the pattern's parameters: `/hooks/whatsapp/:name` gives `params.name`.
- `cookies`, the request's cookies, and the route's to set and clear.

What a route throws is answered by its code: `invalid` is a 400, `unauthorized` a 401, `forbidden` a
403, `not_found` a 404 and `too_many` a 429. Anything else is a 500.

Patterns are matched in a fixed order. The more specific pattern comes first, and the catch-all `/*`
comes last. A later plugin's route replaces an earlier one with the same pattern, and `null` removes
it.

A key can also be a whole URL pattern with a host, such as a preview's. It then takes every request
to the hosts it matches, whatever the path.

No route may take `/connect`, `/oxian` or anything under `/api`. Those are the runtime's.

## Who a request is

Each plugin may have a `who`: a function from the request to an actor, or nothing, so the next
plugin can say. The runtime asks each in plugin order, once per request. If none answers, the
request is anonymous, `{ kind: "anonymous", id: "" }`.

What a `who` queries is kept for 5 seconds, so a page's burst of requests asks once.

Apps rarely write one. Identity, the api plugin and the site chat each have theirs. Identity's is
the whole of it:

```ts
who: (_request, { cookies, query }) => {
  const secret = cookies.get("session");
  return secret ? query("credential.actor", { secret }) : null;
},
```

## Cookies

The runtime names and sets cookies. A route sets and clears its credential's cookie through
`ctx.cookies`: `get(name)`, `set(name, secret, { days, sameSite })` and `clear(name)`. No plugin
writes `Set-Cookie` itself.

Every cookie is `HttpOnly`, on the whole site (`Path=/`), and never has a `Domain`. Over https it's
`Secure` and named `__Host-<name>`, so no other host under the domain, such as a preview's, can set
one in its place. Only over plain http to this machine (`localhost`, or a name under it such as
`acme.localhost`), or to one on its network (a private address, a `.local` name), does it keep its
plain name.

A cookie is `SameSite=Lax` unless its plugin asks for `Strict`, as a site visitor's does. A response
that sets one is never cached.

The app renames cookies with a `cookies` resource, such as
`{ names: { session: "dir" }, suffix: "_acme" }`. That's how runtimes that share a host keep theirs
apart.

## How the page connects

The page trades its cookie for a one-time ticket at `POST /connect`. It then talks to the owner over
its socket, `/oxian`, as an untrusted worker bound to that actor, under the access rules.

The page also says where it is. A space's page, `/space/<id>`, is in that space. Any other page is
where the person works: the space `start` gave, or the one `?in=` names. What its Views call is done
there, as the work's `in`. Code of the page's own says it with `client.call(…, { in })`.

The page says it, and nothing proves it. It's what the record shows, and where the work a call sets
going is. A person's own reach isn't narrowed by it: they reach what they reach from any page. An
agent's turn works where its chat is, which the turn reads itself, so a page can't move what an
agent reaches.

Requests from other sites are refused. A request that may change something (anything but GET, HEAD
and OPTIONS), sent by another site's page, without an `Authorization` header, gets a 403. The
browser's `Origin` or `Sec-Fetch-Site` header says where it came from. So another site can't sign
its visitors in, or act with their cookies. Webhooks send no `Origin`, and pass. Over plain http,
only this machine's pages and its network's are the app's own: `localhost`, any name under it
(browsers send `*.localhost` here, so `http://acme.localhost:8100` tries one brand of an app by its
host), loopback and private addresses, and `.local` names.

Behind a front of the app's own, such as a Cloudflare worker, the `caller` resource's `front` secret
says which requests the front vouches for. The host it forwards (`x-forwarded-host`) is then the
request's.

## A web app on Node

The server composes the app's plugins with the page plugin, and listens:

```ts
// server.ts
import process from "node:process";
import { createRuntime, definePlugin } from "copilotz";
import { memoryStore } from "copilotz/stores/memory";
import { devSignIn } from "copilotz/plugins/access";
import { webPage } from "copilotz/web/server";
import { themeOf } from "copilotz/web/theme";
import { bundle, listen } from "copilotz/web/node";
import { plugins } from "./app.ts"; // models, chat, access, … and the app's own

// This machine alone, unless HOST says (0.0.0.0: everyone's).
const hostname = process.env.HOST ?? "127.0.0.1";
const runtime = await createRuntime({
  store: memoryStore(),
  plugins: [
    ...plugins,
    // Sign in by name: only while it listens on this machine alone.
    ...(hostname === "127.0.0.1" ? [devSignIn] : []),
    webPage,
    definePlugin({
      name: "page",
      resources: {
        // The browser's code, bundled once, on the page's first request.
        page: { title: "Notes", code: () => bundle(new URL("./browser.tsx", import.meta.url)) },
        theme: themeOf([]), // Copilotz's look; a brand passes its theme plugins
      },
    }),
  ],
});
const server = await listen(runtime.fetch, { hostname, port: 8080 });
console.log(`${server.url}`);
// A deploy's SIGTERM: stop listening, give running turns a while, close the runtime.
process.once("SIGTERM", async () => {
  await server.shutdown();
  await runtime.close({ drain: 8_000 });
});
```

The browser's code runs the web host with the front ends it shows:

```tsx
// browser.tsx
import { web } from "copilotz/web";
import { webShell } from "copilotz/plugins/interfaces/web";
import { chatWeb, memoryWeb } from "copilotz/plugins/agents/web";
import { teamWeb } from "@copilotz/team/web";
import { spacesWeb } from "copilotz/plugins/access/web";

await web({
  root: document.getElementById("app")!,
  plugins: [webShell, chatWeb, spacesWeb, teamWeb, memoryWeb],
  start: async (client) => ({
    space: (await client.call<{ space: string }>("space.personal", {})).space,
  }),
});
```

On Node, `bundle` needs `esbuild` installed beside Copilotz, and the front ends' types need
`@types/react`.

The page plugin serves 4 kinds of things:

- the code under `/app/`, split where it imports lazily (math, a terminal);
- the app's own files under `/assets/` (`page.assets`);
- the manifest and the service worker;
- the page itself, for any other GET a browser navigates to.

Its `page` resource is `{ code, title?, lang?, assets?, base? }`. `code` is the bundle, or a
function that bundles it once, so remote executors never hold it.

`listen` serves any fetch handler with Node's HTTP server, through Oxian's Node adapter, sockets
included. It tells the runtime the address each request came from. Bun runs it too.

On Deno, `Deno.serve({ hostname, port }, runtime.fetch)` is the whole host, and `deno bundle` makes
the code, as `examples/terminal-agent/web.ts` does. The Node example is `examples/web-node/`, run
with `node examples/web-node/server.ts`.

## Signing in

Each way to sign in is a plugin. Add the ones the app uses.

- **By name, on this machine** (`devSignIn`). It's for trying an app out. The socket's address and
  the host must both be this machine's (`localhost`, a name under it, or a loopback address), with
  no header a proxy adds. An app whose `links` origin is public doesn't start with it.
- **With Google** (`googleSignIn`). Give the `google` resource your OAuth `clientId`, and the page
  shows Google's button.
- **With an email and a password** (`emailSignIn`). It needs `email`, which says how mail goes, and
  the `links` resource. The page shows its form, and its screens for making an account, the code, a
  new password and an invitation's link. With `signInByCode: true`, people may sign in with a code
  sent to their address instead, with no password: the page offers "Email me a code instead".
- **With a username and a password** (`passwordSignIn`). For staff and back-office apps, whose
  accounts an admin or an import makes: nobody signs up, and there's no email to reset by. The
  identifier is anything the app chooses (a username, a badge number, a CPF). The page shows its
  form, or, beside email sign-in, a link to it.

When someone signs in by an email a person already has, such as a person who moved in from another
app under an id of their own, they sign in as that person, as they are.

Email sign-in, with Resend sending the mail:

```ts
plugins: [
  ...plugins,
  email,
  emailSignIn,
  definePlugin({
    name: "app",
    resources: {
      links: { origin: "https://app.example.com", secret: process.env.LINKS_SECRET },
      email: {
        adapter: "resend",
        from: "App <noreply@example.com>",
        apiKey: process.env.RESEND_API_KEY,
      },
      // On a laptop: email: { adapter: "console" } writes each message to the log.
    },
  }),
];
```

Email goes through Resend (`adapter: "resend"`), a mail server (`adapter: "smtp"`), a sendmail
program (`adapter: "sendmail"`, with `sendmail: { path?, args?, timeout? }`: the message goes on its
stdin, never through a shell), or, on a laptop, the log (`adapter: "console"`). The `smtp` adapter
speaks over `node:net` and `node:tls`, so it runs on Node, Deno and Bun, not on workerd. It moves to
TLS before it says anything: from the start with `secure: true` (port 465), else with STARTTLS (port
587), and it refuses a server that doesn't offer STARTTLS unless `starttls: false` says it's one on
this machine:

```ts
email: {
  adapter: "smtp",
  from: "Loja <loja@example.com>",
  smtp: { host: "smtp.example.com", user: "loja", password: process.env.SMTP_PASSWORD },
},
```

Trusted code sends its own mail with `email.send`, from the app's `from` or another address the
`email` resource's `senders` allow, with where replies go and files in base64 (10 MiB in all):

```ts
await ctx.call("email.send", {
  to: customer.email,
  from: "Billing <billing@example.com>", // listed in email.senders
  replyTo: "help@example.com",
  subject: `Your invoice ${invoice.number}`,
  text: "Your invoice is attached.",
  attachments: [{ filename: `${invoice.number}.pdf`, content: pdfBase64 }],
});
```

A file with an `id` is inline: the HTML points to it as `cid:logo` (`<img src="cid:logo">`), so a
big logo needn't be a data URL in the 500,000 characters of `html`. It needs `html`, and goes as a
`multipart/related` part with a `Content-ID`. `mime` (exported by the email plugin) writes a
message's source, for an adapter of your own.

```ts
attachments: [{ filename: "logo.png", content: logoBase64, id: "logo" }],
```

Accounts by username are trusted code's. An admin's screen calls `password.set` through an Action of
the app's that says who may, and a migration brings people with the hashes another app kept
(bcrypt's `$2a$`, `$2b$` and `$2y$` too: hashed again Copilotz's way at the first sign-in).
`email.import` takes them as well:

```ts
plugins: [
  ...plugins,
  passwordSignIn,
  definePlugin({
    name: "app",
    // A CPF typed with its dots and dash is the same CPF.
    resources: { passwordSignIn: { ignore: ".-/" } },
  }),
];

// An Action of the app's, for whoever it lets manage staff.
await ctx.call("password.set", {
  person: employee._id,
  identifier: employee.username,
  password: input.password, // optional: 8 characters at least; a new one ends their sessions
  name: employee.name,
});
// A migration, as the system.
await runtime.call("password.import", { person: "emp-7", identifier: "ana", hash: row.password });
```

A person signed in changes their own with `POST /signin/password/change` `{ password, new }`.
`password.remove` `{ person }` takes an account away, and ends its sessions.

Signing out is `POST /signout`. It ends the session, disconnects its browsers and clears the cookie.

## The sign-in page's words

The sign-in page is the app's, in every word. Beside the form it shows the app's logo (its theme's
`logo`), its name (the page's title) and its own pitch.

Both come from the `signInPage` resource of the browser's plugins, the ones `web({ plugins })` runs.
It merges over Copilotz's, as the theme does:

- `words` patch one by one, by key. `SIGN_IN_WORDS`, from `copilotz/web`, lists them all, with their
  blanks such as `{email}` and `{seconds}`.
- `about` is a headline, its quieter end and a few points. It's given whole, so no Copilotz pitch
  stays beside the app's own. `null` leaves the form alone.

An app that says nothing shows Copilotz's words and pitch. Refusals are said in these words, by
their code, never in the server's. In Brazilian Portuguese, they're all said already: `ptBR`, from
`copilotz/web/pt-br`, first among the page's plugins, gives every word of the sign-in page,
Copilotz's pitch, and every word of the front ends (hosts/web/WORDS.md).

What the app's own data says, the server sends as the app declared it: its tiers' descriptions, its
kinds of work, its agents' descriptions. Front ends show it through `sayText`, so the app gives it
in another language among its `words`, under `text.` and the English word for word
(`"text.Quick answers.": "Respostas rápidas."`). Text it gives none for, one an org wrote itself,
shows as written.

The messages email sign-in sends are the server's `emailSignIn.messages`. Setting a message's `html`
to `null` sends it as text alone. `page.lang` says the page's language, and Google's button follows
it.

An app that serves brands on hosts of their own says, per host, what changes there:
`emailSignIn.hosts`, by the host the page was served on, gives its name, its sender (one the `email`
resource's `senders` allow), its messages' words and where its links go (`https://<host>` unless its
`origin` says). Trusted code inviting someone for a brand passes its host to `email.invite`:

```ts
emailSignIn: {
  app: "Abordo",
  hosts: {
    "passaromarron.com.br": {
      app: "Pássaro Marron",
      from: "Pássaro Marron <nao-responda@passaromarron.com.br>",
      messages: { verify: { subject: "{code} é o seu código no {app}" } },
    },
  },
},
email: { adapter: "resend", from: "Abordo <nao-responda@abordo.com.br>", senders: ["@passaromarron.com.br"], apiKey },
```

An app in Portuguese, with its own pitch and a few words its own way (the rest are `ptBR`'s):

```tsx
// browser.tsx
const brand = definePlugin({
  name: "brand",
  resources: {
    theme: { light: { primary: "#0F172A" }, logo: { mark: myMark } },
    signInPage: {
      about: {
        headline: "Seus projetos,",
        quiet: "sempre em dia.",
        points: [{ icon: "sparkles", title: "Agentes que ajudam", text: "Respostas em segundos." }],
      },
      words: {
        signIn: "Acessar",
        codeLede: "Mandamos um código de 6 dígitos para {email}.",
        // … any key of SIGN_IN_WORDS the app says its own way
      },
    },
  },
});
// ptBR (from copilotz/web/pt-br) first: the brand, after it, has the last word.
await web({ root, plugins: [ptBR, webShell, chatWeb, spacesWeb, brand] });
// server: page: { title: "Exemplo", lang: "pt-BR", code }, theme: themeOf([brand]),
//         emailSignIn: { app: "Exemplo", messages: { verify: { subject: "{code} é o seu código" } } }
```

## Apps without a page

An app people use on WhatsApp or on the phone needs no page. Leave the page plugin out, and
`runtime.fetch` answers 4 things: its plugins' routes (Meta's webhook, Twilio's), the runtime's own
paths, `GET /health` for whatever watches it, and a 404 for anything else.

Nobody signs in there. A webhook's request is anonymous, so its route checks the request's
signature. It then calls its Actions as trusted code, the system, and they act for the person the
message is from with `ctx.as`.

```ts
import process from "node:process";
import { createRuntime } from "copilotz";
import { listen } from "copilotz/web/node";

const runtime = await createRuntime({ store, plugins });
const server = await listen(runtime.fetch, { hostname: "0.0.0.0", port: 8080 });
process.once("SIGTERM", async () => {
  await server.shutdown();
  await runtime.close({ drain: 8_000 });
});
```

Deno and Bun run it too.

A route may take a WebSocket of its own, such as a voice call's relay, with Oxian's
`upgradeWebSocket`. It answers with the response that gives, and it can refuse first, with a 403,
before any handshake. The socket behaves like a browser's `WebSocket` for `onmessage`, `send` and
`close`. `listen` and `Deno.serve(runtime.fetch)` complete the upgrade.

```ts
import { upgradeWebSocket } from "@oxian/oxian-js/http"; // on npm, "oxianjs/http"

routes: {
  "/voice/relay": (request, { runtime }) => {
    if (!signed(request)) return new Response("Forbidden", { status: 403 });
    const { socket, response } = upgradeWebSocket(request);
    socket.onmessage = async (event) => socket.send(await answer(runtime, event.data));
    return response;
  },
},
```

Remote executors connect to the runtime's own socket, `/oxian`, with its key, through the same
`runtime.fetch`. The example is `examples/web-node/routes.ts`.

## Tests

Tests need no listener:

```ts
await runtime.fetch(new Request("http://localhost/hooks/ping", init));
```

To connect a client in the process as someone, add `testWho` from `copilotz/testing` to the plugins,
and take its tickets from `/connect` with `ticketFor(runtime, actor)`.

## Related

- [Many orgs behind one address](many-orgs.md): one `fetch` for every org.
- [Visitors](visitors.md): a public site where anyone chats with the app's agent.
- [The REST API and the client](rest-and-the-client.md): `/api/`, and scripts that use it.
