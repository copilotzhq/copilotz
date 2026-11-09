---
title: "Chapter 40: Sign-in and people"
description: "On Copilotz's identity, a request is whoever its session proves, so people sign in: by email and a password, with codes written to the log on this machine, or by name. Then a space gets members: Ana invites Bruno to Launch, he accepts, and he reads its board."
section: Build Compass
order: 400
status: stable
---

# Chapter 40: Sign-in and people

> Part 13, from one person to many · Requires: Chapter 39 · Code: `lesson-13.2`

## The pain

Compass now runs on Copilotz's plugins, but it still has one person in it. Bruno is working on the
launch with Ana. He should see the Launch board, and add to it. On your identity there's no Bruno:
every request from this machine is you, and anything else is nobody.

## The problem

Two people need two things your plugins never had. First, a request has to say **who** it is. Your
identity decided that from where the request came from. Copilotz's decides it from a session: its
`who` reads the session cookie and asks `credential.actor` whom the secret proves
(`plugins/access/identity/mod.ts:51`). Without a way to sign in, nobody has a session, so on the web
nobody is anyone.

Second, a space needs **members** besides you. Copilotz's spaces have them: a manager invites an
email, with a role, and whoever signs in with that email accepts. Sending answers the same whether
the address has an account or not, so an invitation never tells anyone who's signed up
(`plugins/access/spaces/actions/invitation.ts`). Both parts are already in Copilotz's list from the
last chapter. What's missing is a way in.

## The solution

### Signing in, by email

Copilotz signs people in with plugins of their own. `emailSignIn` takes an email and a password, and
sends a six-digit code to confirm the address. It sends through `email`, the app's email port, whose
`console` adapter writes each message to the log instead, for a laptop. Both need the `links`
resource: where the app is, and a secret its codes are kept sealed with (`check` in
`plugins/access/email/mod.ts:156`). `app.ts` takes them as one setting:

```ts
export type Settings = {
  // …
  /**
   * With `copilotz`, where the app is and a secret of its own, for signing
   * in by email: its links go to the origin, its codes are kept sealed with
   * the secret.
   */
  links?: { origin: string; secret: string };
};
```

The settings plugin gives them to the plugins:

```ts
// Signing in by email, on Copilotz's identity: each message written to the log, here.
...(settings.copilotz && settings.links
  ? {
    links: settings.links,
    email: { adapter: "console" },
    emailSignIn: { app: "Compass" },
  }
  : {}),
```

and Copilotz's list adds the two plugins, after identity, which they require:

```ts
agents.history,
...access,
// People sign in with an email and a password.
...(settings.links ? [email, emailSignIn] : []),
work.boards,
```

The `console` adapter is for this machine only: the `email` plugin refuses to start with it when
`links.origin` is somewhere public (`plugins/access/email/mod.ts:114`), since a code in a log is a
way in.

### And by name, from this machine

`server.ts` reads `COMPASS_COPILOTZ=1` and passes the settings, and adds `devSignIn`: sign in by
typing a name, from this machine only. Its route answers only a request from a loopback address to a
loopback host (`fromHere`, `plugins/access/dev/routes/sign-in.ts:18`), so it's the host's choice to
add, not the app's.

```ts
const port = Number(process.env.PORT ?? 8080);
const copilotz = process.env.COMPASS_COPILOTZ === "1";
// Where email sign-in's links go, and what its codes are sealed with.
const links = {
  origin: `http://127.0.0.1:${port}`,
  secret: process.env.COMPASS_SECRET || randomUUID(),
};
// …
const runtime = await createRuntime({
  // …
  plugins: [
    ...plugins({
      you: me,
      openai: process.env.OPENAI_API_KEY,
      ...(copilotz ? { copilotz, links } : {}),
    }),
    // Signing in by name, from this machine only.
    ...(copilotz ? [devSignIn] : []),
    // …
  ],
});
```

Without `COMPASS_SECRET`, each start makes a new secret: codes not used yet are gone when the server
stops, which on your machine is fine. The page's sign-in screen is Copilotz's web host's: it asks
the routes which ways are here (`GET /signin/dev`, `GET /signin/email`) and shows a form for each.

### Ana invites Bruno

`tests/people.test.ts` does the whole thing the way a page does, through `runtime.fetch`. Email goes
to an inbox the test reads, an adapter of the `email` port that keeps each message: the only fake.
Each person makes an account with the code they're sent:

```ts
async function signUp(
  { runtime, inbox }: Awaited<ReturnType<typeof app>>,
  email: string,
  name: string,
) {
  const asked = await post(runtime, "/signin/email/sign-up", {
    email,
    password: "correct horse",
    name,
  });
  assert.equal(asked.status, 200);
  const sent = inbox.findLast((message) => message.to === email)!;
  const code = sent.text.match(/\b\d{6}\b/)![0];
  const verified = await post(runtime, "/signin/email/verify", { email, code });
  assert.equal(verified.status, 200);
  const cookie = verified.headers.getSetCookie()[0].split(";")[0];
  const session = cookie.slice(cookie.indexOf("=") + 1);
  const actor = await runtime.query<Actor | null>("credential.actor", { secret: session });
  return { actor: actor!, cookie, subject: sent.subject };
}
```

A person made by email gets an id of their own (`email:<random>`,
`plugins/access/email/shared/people.ts:26`), and the session's cookie says who they are. Then Ana
makes Launch and its board. Bruno reads it as a page reads a board, its boards and cards under the
rules, and finds nothing. She invites him; he finds the invitation, accepts, and reads it again:

```ts
assert.deepEqual(await read(bruno), { boards: [], cards: [] }, "not his, yet");

// She invites him by email; he sees it, and accepts.
await runtime.call("invitation.send", { space, email: "bruno@example.com" }, as(ana));
const [invitation] = await runtime.query<Invitation[]>("invitation.mine", {}, as(bruno));
assert.equal(invitation.name, "Launch");
assert.equal(invitation.role, "editor");
await runtime.call("invitation.accept", { invitation: invitation._id }, as(bruno));

// Now the board is his to read too.
assert.deepEqual(await read(bruno), { boards: ["Launch plan"], cards: ["Record the trailer"] });
```

An invitation's role is `editor` unless the manager says otherwise, so Bruno may write in Launch too
(`space.can` answers `{ can: true }`).

## Run it

The test, on its own:

```sh
node --disable-warning=ExperimentalWarning --test tests/people.test.ts
```

```text
✔ Ana invites Bruno into Launch, and he reads its board (210.890625ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 519.794292
```

With the `console` adapter, what the server writes to its log when Bruno signs up is the message
itself, code included:

```text
[email] to bruno@example.com
  947878 is your code for Compass

  Your code to confirm this email for Compass:

  947878

  It works for 15 minutes. If you didn't ask for it, ignore this email: nothing happens without the code.
```

## Check it

`tests/people.test.ts`: two accounts made through the sign-up and verify routes, each confirmed with
the code its email carried; `/me` names the person the cookie proves; a board in Launch that Bruno
can't read until he accepts Ana's invitation, and reads after.

## Also in this chapter

- `.env.example`: `COMPASS_SECRET`.
- `server.ts`: its doc comment says how people sign in on Copilotz's plugins.

`git diff lesson-13.1 lesson-13.2` shows every change.

## What you have now

Compass for more than one person: on Copilotz's plugins, people sign in, by email or by name on this
machine, and share a space by invitation. Your own plugins are still the default, for you alone.
