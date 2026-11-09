# @copilotz/directory

Many orgs behind one address, for [Copilotz](https://github.com/copilotzhq/copilotz): who signs in,
which orgs each belongs to, invitations to orgs by email, where each org lives, the hosts orgs
claimed, and platform staff. An app that serves one org doesn't need it.

```sh
npm install @copilotz/directory copilotz          # Node 24+, Bun
deno add jsr:@copilotz/directory jsr:@copilotz/copilotz
```

It goes with Copilotz at the same version (they're released together): `@copilotz/directory@x.y.z`
with `copilotz@x.y.z`.

The directory is a runtime of its own, in front of every org's: its `fetch` is the app's. It answers
what's its own (signing in, `/orgs`, staff's `/console`) and hands everything else, sockets
included, to the org's runtime, each opened when first used and closed when idle:

```ts
import { createRuntime, definePlugin, runtimes } from "copilotz";
import { googleSignIn, identity } from "copilotz/plugins/access";
import { directory } from "@copilotz/directory";

const dir = await createRuntime({
  store,
  plugins: [
    identity,
    googleSignIn,
    directory,
    definePlugin({
      name: "d",
      resources: { directory: { staff: ["you@example.com"], orgs, lobby } },
    }),
  ],
});
const orgs = runtimes(async (id) => {
  const org = await dir.query("org.info", { org: id });
  return org &&
    await createRuntime({ store: storeOf(org), plugins: [...app, directory.member(dir, org)] });
});
Deno.serve(dir.fetch);
```

In the browser, `directoryWeb` fills the web shell's `orgs` slot: the org switcher at the top of the
sidebar, going between orgs, the org's page (`/org`, its sections the `orgSettings` resource's) and
staff's console (`/console`). Without it, the shell has no switcher:

```ts
import { directoryWeb } from "@copilotz/directory/web";

await web({ plugins: [webShell, chatWeb, spacesWeb, directoryWeb], root });
```

| Import                         | What it has                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `@copilotz/directory`          | `directory` (and `directory.member(dir, org)`, what each org's runtime gets of it)                         |
| `@copilotz/directory/web`      | `directoryWeb`, and the browser half: `useOrgs`, `enterOrg`, `createOrg`, `refreshOrgs`, `consoleOrgs`…    |
| `@copilotz/directory/contract` | the browser half, for other plugins' front ends: `useOrgs`, `orgName`, `asStaff`, `type Orgs`, `GiftCode`… |

Its collections are `org`, `membership`, `invite`, `staff`, `orgHost` and `creditCode`; its cookies,
`dir` (`__Host-dir`), `org` and `s_<org>`. The roles in an org (owner, admin, member, guest) are the
spaces plugin's, in each org. Its front end's words keep the keys they had in the web shell
(`shell.<key>`): see
[WORDS.md](https://github.com/copilotzhq/copilotz/blob/main/packages/directory/WORDS.md).

Through 1.0.0-rc.32 this was `directory` in `copilotz/plugins/access`, its browser half in
`copilotz/plugins/access/web`, and the switcher was the web shell's own. Its names (collections,
Actions, events, Views, routes, resources) are the same, so an app's data stays as it is: only its
imports change, and the page adds `directoryWeb`. See
[design/plugins.md](https://github.com/copilotzhq/copilotz/blob/main/design/plugins.md) and
[design/tenancy.md](https://github.com/copilotzhq/copilotz/blob/main/design/tenancy.md).
