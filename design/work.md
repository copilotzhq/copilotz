# Work: who, for whom, where

Agreed 2026-11-08. The runtime carried who acts, and agents carried for whom (`for`), but where the
work was stayed in each plugin: tools read their chat to find its space, and reach ignored it. The
four core agents are members of every space, so North working for Ana in a shared space reached all
of Ana's spaces, and only labels stood between her Finance and Launch's members. Now all work runs
as who, for whom, where, and an Action's `allow` is asked wherever someone acts.

## The trio

- **All work runs as `{ agent, for, in }`:** who acts, for whom, and where. It is one actor:
  `{ kind: "agent", id: "north", for: { kind: "person", id: "ana" }, in: "launch" }`. A person
  acting themselves is `{ kind: "person", id: "ana", in: "launch" }`; a contact on a line,
  `{ kind: "contact", id, in: <the line's space> }`.
- **`in` is opaque to the runtime,** like an actor's `id`. Only the access plugin says what a space
  is. It's optional: the system's work, and an app without spaces, leave it out, and nothing
  narrows.
- **It fits sign-in for outside assistants** (MCP sign-in, proposed): a token is
  `{ kind: "agent", id: "chatgpt", for: ana }`, its consent a member of the spaces Ana picks, and a
  line says where its conversations are. Nothing here needs changing for it.

## What the runtime carries

`in` is a field of the actor, so it goes wherever the actor goes, at no cost of its own:

- into every `ctx.call`, the tools a turn runs, the Processors a call's events wake, its timers (and
  so routines), and the Views observed for it;
- onto every event (the log records it with the actor);
- to `guard` and `allow`, which get the whole actor;
- into contexts: `ctx.in` for Actions, Processors, tools (`ToolContext`), queries and Views.

`ctx.as(other)` stays where the work is unless `other` says where (`in`, or `in: undefined` for
nowhere); `ctx.as()` (the system) records it too.

Every way in says it:

| Way in                  | Who, for whom                                | Where (`in`)                                |
| ----------------------- | -------------------------------------------- | ------------------------------------------- |
| The web                 | the person                                   | the page's space (a call says it)           |
| A chat's turn           | its agent, for whoever started it            | the chat's space                            |
| WhatsApp                | the customer (a contact), or a linked person | the number's space; the space they write in |
| Voice                   | the caller (a contact), and its agent for it | the line's space                            |
| A web line, an MCP line | the visitor or conversation (a contact)      | the line's space; a tool, where its chat is |
| A developer key         | its person, through it                       | its space                                   |
| The terminal            | its person                                   | where they work (`/space`, `/work`)         |
| A routine               | its maker, as set going by it (`origin`)     | the routine's space                         |
| Handing work to a space | the same person                              | the new space (see below)                   |

What a browser says is said, never proved: it's what the record shows and what the call causes, and
a person's own reach isn't narrowed by it. What an agent reaches is set by its chat's space, which
the turn reads itself. So the same trio reaches the same whichever way it came in: a host, a page
(even one saying it's elsewhere), the terminal, a routine, a key, a hand-over
(`plugins/access/tests/where.test.ts`).

## What the spaces plugin owns

What a space means stays in `plugins/access/spaces`: members, roles, invitations, sharing, sources,
archiving, orgs. It gives `in` its meaning:

- **Reach for work done for someone** (an agent's, a key's, or a person's done for them, `onBehalf`:
  a routine's, or a tool's acting as its agent's person) that is somewhere is **the person's reach ∩
  the agent's memberships ∩ `in`, and what `in` draws on**, at most with the role `in` holds there
  (a viewer of Marketing reads it, never writes it).
- **Ana's own Personal space is the exception:** only she sees what's said there, so her agents
  there reach all she does, and labels mark what they bring in. That's where reaching across her
  spaces is safe, and it keeps "private chats reach across all your spaces".
- **A person acting themselves isn't narrowed,** nor is code acting as them for themselves (asking
  whether they may write somewhere): they reach what they reach from any page, and what they cause
  (a turn) is narrowed where it runs.
- **Who's where isn't content:** spaces and memberships are read as far as the person behind the
  work reaches, wherever it is (an agent asking who's in a space it hands work to; a tool asking its
  person's org role).
- **Work that spans spaces** is either nowhere (`in` absent: the system's, an app without spaces) or
  in one space that draws on the others. No sets of spaces: what a space draws on is explicit,
  durable, and shown to its people ("Launch draws on: Marketing"), which a set carried on one call
  wouldn't be. Handing work to another space is the other way.

## Reach, kept

Reach is asked on every op an actor's work makes, and comes from data that changes rarely. The owner
now keeps what rules work out (the runtime's `ReadContext.kept`), by a key and with what it read
(each read's collection and filter), and lets it go when a commit changes a document one of those
reads matched, before or after: exactly when it could have changed.

- **Reach is kept per who, for whom and where** (`reachKey`; a person's own on every page alike), an
  agent's memberships and its person's reach apart, so they're worked out once for every place it
  works. Lists of a reach (`where`) are made once.
- **Nested answers** pass on what they read: Ana's memberships changing lets go of every agent's
  reach for her. A View observed for an actor reads what its rules read, kept or not, so it follows
  its reach as before.
- **Bounded** (1,000 answers unless `cache.kept` says), let go entirely by maintenance SQL, and not
  kept with `cache: false`.
- **Signalled where commits are seen** (`committed`, beside the read cache), before anything
  reacting to them reads.

### What it costs

`examples/work-bench.ts`: 1,000 spaces of 50 notes; Ana in 500, North (as a core agent) in all. Each
figure is a whole call through the runtime, 200 runs after 20; SQLite, 2026-11-08, on one laptop.
Median / p95 ms, before and after:

| North for Ana in a space   | before      | after       |
| -------------------------- | ----------- | ----------- |
| one space                  | 1.91 / 2.28 | 0.76 / 0.94 |
| all it reaches             | 1.84 / 2.10 | 0.63 / 0.71 |
| a turn's work (13 ops)     | 21.5 / 22.9 | 4.39 / 5.28 |
| **Ana herself**            |             |             |
| one space                  | 1.07 / 1.26 | 0.58 / 0.65 |
| all she reaches            | 1.11 / 1.31 | 0.62 / 0.68 |
| a turn's work              | 11.7 / 12.2 | 4.70 / 5.57 |
| **North for Ana, nowhere** |             |             |
| one space                  | 1.81 / 2.01 | 0.58 / 0.62 |
| all it reaches             | 1.82 / 2.00 | 0.63 / 0.67 |
| a turn's work              | 21.2 / 67.3 | 4.66 / 5.57 |

Nothing got slower. Kept reach takes the rules from working out 1,500 memberships on every op to a
lookup; narrowing makes an agent's filters one space instead of 500; and a turn in a shared space
reads nothing its members can't see, so its write carries no labels to work out. (Before, North
writing in a space after reading everywhere carried ten spaces' labels. A second round on the same
machine agreed, medians within 3%.)

## Who may call (#1)

- **Code acting for someone calls only what lets them.** An Action's `allow` was asked only of
  outside callers; tools, Processors and Actions calling `ctx.call` skipped it. Now it's asked
  wherever an actor calls: from outside, from code (`ctx.call`), from a timer, and from a read's
  unrecorded calls. For an agent it's asked for the agent and for whom it works (`allows`).
- **Actions without an `allow` stay internal:** code calls them for anyone; outsiders can't.
- **Going beyond is a named grant:** `ctx.as(grant("chat.hand-over"))` acts as the system, for one
  reason, on the record as the grant `via` whose work it was and `in` where; the owner counts its
  ops (`copilotz.elevated.ops`, by grant). The model never holds one: code decides what leaves it.
  Copilotz's own: `chat.hand-over`, `chat.hand-back`, `web.budget` (pricing a visitor's use).
- **The helpers say what they mean for an agent:**
  - `people` and `peopleOrContacts` let in an agent working for someone they let in;
  - `inPerson` never lets in an agent, whomever it's for, nor work done for a person (`onBehalf`: a
    key, a routine's run, code acting as them for an agent);
  - chat's `themselves` (people and contacts writing as themselves) is `chat.send`'s and
    `chat.attach`'s: an agent never puts words in its person's mouth.
- **Copilotz's own Actions, one by one.** `inPerson` for what only the person decides:

  | What                  | Actions                                                                                                                                                                                                |
  | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | sessions and accounts | `session.end`, `account.connect`, `account.complete`, `account.callback`, `account.disconnect`, `modelKey.set/remove`                                                                                  |
  | who's where           | `space.create`, `space.leave`, `member.set`, `member.remove`, `invitation.*`, `request.*`, `org.role`, `org.remove`, `org.invite`, `org.uninvite`, `org.rename`                                        |
  | showing to new eyes   | `share`, `chat.move`, `memory.move`, `app.publish`                                                                                                                                                     |
  | trust                 | `agent.create/update/delete`, `api_key.*`, `computer.code`, `computer.work`, `computer.approve`, `computer.allowOrigin`, `computer.forgetGrant`, `contact.forget`, `voice.block/unblock`, `whatsapp.*` |
  | money                 | `tiers.choose`, `tiers.pick`, `billing.setPlan/grant/waive/pay/budget/redeem/checkout/portal`                                                                                                          |

  Everything else is `people` (or `peopleOrContacts`), boards and documents included: they said "a
  person", which kept their own tools' agents out. Code that took the actor's id for its person's
  now asks `personOf`; an environment changes only by a manager of its space, whoever asks.

## Simplified

- **Tools know where they are** (`ctx.in`): documents, boards, computers (`whereFor`, `whereAwake`,
  `computer.allowed`, `preview`), cloud computers, apps, memory, skills, routines and an API's files
  no longer read their chat to find its space.
- **The mcp plugin:** a listed tool without its `tool:<name>` View stops the app from starting (it
  was left out quietly, said once in the log); its security note now says what reaches past a
  contact (internal Actions, grants, unruled collections), since every `allow` is asked.
- **Labels:** an agent's `at` is `in`. In a shared space an agent reads only the space and what it
  draws on, which its members all see, so its answers there carry no labels; they arise where they
  still can (its person's Personal space, a person's own writes, a chat moved from Personal).
- **Memory:** what's learned stays where it was learned (`ctx.in`); `recall` elsewhere and `forget`
  reach only where the agent works, and `elsewhere` lists other spaces only in its person's Personal
  space.
- **Routines** run as their maker, in the routine's space, and check there that they may still
  write, wherever their timer was set from.
- **Handing work to another space:** the same person, the new space, under its grant on the record;
  its check is the person's, anywhere.

## Not simplified, and why

- **`principalOf` still walks `for`, then `via`:** a hand-over's and a hand-back's writes are a
  grant's, and the turns they start find the person through `via`. `in` says where, not for whom.
- **`shared`'s `contact` filter stays:** it keeps an agent's private steps from the contact in the
  same chat, which no space can say.
- **Labels stay:** Ana's Personal space reaches across her spaces, a person's own writes aren't
  narrowed, and chats move.
- **`account.token`** stays internal and unchanged: whether outside assistants may use connected
  accounts is MCP sign-in's question.
- **Queries run by plugin code** (`collection.query`) still don't ask `allow`: their reads keep to
  the rules, and only outside callers ask (`askable`, for an agent with its person too).
- **Collections no rule speaks for** stay unchecked for trusted code (MCP sign-in proposes closing
  them to outside actors).

## Upgrading apps

Mobizap, Cocria and Compass:

- **`people` lets agents in.** Its Actions are now asked for code acting for someone. An Action
  whose run takes `ctx.actor.id` for a person's id, or skips a check unless
  `ctx.actor.kind === "person"`, reads `personOf(ctx.actor)`, or says `inPerson`. Pick `inPerson`
  for what only the person decides (consent, keys, membership, money, publishing); `people` for the
  rest. An `allow` written as `(actor) => actor.kind === "person"` keeps agents out of the app's own
  tools: say `people`.
- **Tools calling Actions an agent's person couldn't** are refused (`forbidden`). Say `people` on
  the Action, or go beyond on purpose with `ctx.as(grant("<why>"))`.
- **An agent reaches only where it works** (and what that space draws on): a tool that read across
  its person's spaces from a shared chat finds less. Draw on the other space (`member.set` of a
  space into it), work from the person's Personal space, or hand the work over.
- **Tools say where they are:** read `ctx.in` instead of the chat's `in`. Hosts calling as a person
  in a space may say it (`{ actor: { ...ana, in } }`; a browser client's `call(…, { in })`).
- **MCP:** a line listing a tool without its `tool:<name>` View no longer starts.
- **An agent actor's `at` is `in`;** a timer set with `at` before runs as it was, not narrowed.

## Open

- **The Personal space exception** is derived, not stored: a Personal space draws on all its
  person's spaces. The alternative is narrowing there too, and listing Personal's sources.
- **Narrowing a person's own work** by the page they're on: not done (it would refuse moving a chat
  from one space's page to another, and adds nothing a person couldn't do by opening the other
  page).
- **`space.create` and `agent.*` as `inPerson`** keep keys out too; an app that provisions spaces or
  agents with a key would call them as the system.
