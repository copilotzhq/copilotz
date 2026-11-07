# Access: who can see and do what

Agreed 2026-10-27, after reading how Copilotz 0.x and an app on it do it (about 8k lines of platform
authorization and 6k of product policy). What made those heavy: who is calling isn't carried down
the chain of causes, so every operation re-derives it; one imperative `evaluate()` answers ten kinds
of intent; tenancy is mixed into the policy; secret-bearing records need `public*` mirror
collections. What we keep from them: limits as filters, writes checked against the resulting
document, fresh decisions, explicit actor kinds, failing closed.

## The principle

**Reading is free; showing is a decision.** Nothing appears in front of someone who couldn't see
where it came from, unless a person with the right to share it chooses to. Agents never ask to read;
friction appears only where something would reach new eyes. The agent is never the security
boundary: the runtime enforces, so agents can be naive and still safe.

## Where things live

- **Resource → space → org (namespace) → tenant.** Anything made in a space belongs to it; anything
  made in your private chats belongs to your Personal space (one per user).
- **Org and tenant are one concept placed two ways:** small orgs share a schema, an org that needs
  isolation gets its own. Records carry their space and spaces their org, so moving or exporting an
  org needs no other data model.
- **Login identity is global;** membership is per org.

## Who can do what

- **The actor travels with causes.** An outside call binds one: a person, a key, a device, a
  channel, or the system. Nested calls run as their caller; a Processor runs as the actor of the
  event it handles; a timer fires as whoever set it (declared schedules as the system). Every event
  records its actor, so the log is the audit trail. Who is captured once; what they reach is checked
  fresh at each operation.
- **Sharing is one mechanism for every collection** (a property, built on edges):
  - **spaces:** any document can have members; a shared space or an org is a document that mostly
    holds others; a single doc can be shared on its own (the Google Docs case);
  - **containment:** a shared document lives `in` one space;
  - **members:** an edge from a person, an agent or another space to a space, with a role.

  You reach a document if you're a member of it or of a space containing it, with the role along
  that path. A space can be a member of a space: that's how a space draws on another (sources).
- **Roles are bundles of scopes;** scopes come from the primitives (`board:read`, `board:write`,
  `space:manage`) rather than a hand-kept list.
- **Rules are filters.** Reads are ANDed with the actor's reach; inserts, and the result of every
  update or replace, must match it, so nothing is moved out of reach. A collection without a rule is
  invisible to clients and unchecked for trusted code.
- **Actions say who may call them from outside** (`allow`: the runtime's `people`, or `inPerson` for
  what a key must never decide). Record-level access is the rules'. Where trusted code goes on as
  the system, it first asks `may`, `must` or `mustOwnOr` (the spaces contract), which ask reach:
  nothing else works that out, so every limit on an actor holds everywhere. Two logged escape
  hatches for trusted code: acting as a person (a webhook mapping a number to its person) and acting
  as the system (creating a Personal space at sign-up).
- **Who:** `personOf` (the runtime's) says whose work this is. A developer key is its person
  (`kind: "person"`, with `key` and `scope`) and a member of its space (`key:<id>`): it reaches what
  its membership and its person both reach, with no org role. Its `scope` (exact names of Actions,
  queries, Views, collections) is checked only where a call from outside comes in, never inside the
  work it starts. Every key has a scope: identity makes no keys of its own (see "Developer keys").
- **Direct writes from outside** (REST, the socket) reach a collection only where a rule speaks for
  its writes, asked as the outsider's own (`direct`). A plugin whose records only its Actions may
  change refuses there: spaces, memberships, invitations and requests; people and sessions; keys;
  contacts; messages and what a turn is doing; routines; computers, desks, previews, apps and cloud
  computers; chats (`thread`), messages, files and what was shown after an answer (`shown`);
  memories; skills and their files; agents; accounts; WhatsApp's phones and numbers; voice blocks.
  Still writable directly, each under its rule: apps' own collections (an app whose rules assume its
  Actions refuses there too, as Compass's boards and documents do). Filtering or sorting by a
  private field is refused, over REST and the socket alike. An actor can carry what set it going
  (`origin`: a routine), which only code can set. A message's `via` is only what people are shown:
  anyone can claim it.
- **A space put away** (archived) is read and managed, not written in: reach says so.
- **Leaving** follows the membership (`member.deleted`), however someone left: their computers'
  desks, their yeses and keys for that space end; out of the org, all of them and their own
  computers. A connection stays open but reaches nothing; a preview's cookie asks again on every
  request.
- **Asking** is one record for computers (`approval`, answered into `grant`): once, in a
  conversation, for a routine as it is now, or always. Publishing is only ever once. A request to
  join stays apart: any manager answers it, and what comes of it is a membership.

## Agents

- **Agents are members,** like people: same edges, same roles. Code declares an agent's maximum
  (scopes, tools, whether it may join shared spaces); admins place it within that maximum. The four
  core agents are members of every space by default, listed and removable there.
- **A turn reaches** the person's reach ∩ the agent's memberships. Agents never change memberships;
  only an elevated tool can, after a person confirms.
- **Broader than the person only through code:** elevated Actions and tools run with a grant of
  their own and declare what their output reveals (`salary_band` releases an aggregate). The model
  never holds the grant; the tool's code decides what leaves.
- **No person:** a WhatsApp contact reaches only their conversation, unless a linked phone makes
  them its person; routines act as their creator.
- **Handing work to another space:** an agent may message the agents of any space its person can
  write in (`send_message` with `space`), though it doesn't work there itself. A new chat opens
  there, which its members see, marked as delegated, for the same person, with what set it going;
  the answer comes back to the chat it came from. This goes around labels on purpose: what's handed
  over is what the agent chose to say, and the person accepted that it may repeat something private.
  The agent is told so.

## Source labels

- The owner records which spaces a job read. A write whose space's members can't see all of them
  carries those sources, and the rule becomes "you reach its space and all its sources". Most
  documents carry none.
- **In a shared chat,** an answer that used something not everyone present can see shows only to
  those who can, marked ("Uses Finance. Bob can't see it."), with **Share**: an Action a person
  calls, clearing the sources if they reach them all.
- **A write into another space** that would reveal foreign sources comes back `needs_share`; chat
  turns it into a question to the requester (a wait).
- **Labels can creep:** a turn that skimmed many spaces restricts its answer to "only you", plus
  Share. That's the safe default.

## Memory

Memories are documents with a home, so no separate permission system:

- about you → your Personal space, following you; in shared chats only when you're the only person
  present, or when a shared space adds "my personal notes" as a source;
- about a space's work → that space; about the agent or the org's conventions → the org.

Private chats reach across all your spaces with nothing to grant. "Remember this everywhere" moves a
memory; linking spaces as sources shares durably. What North learned in Launch stays in Launch
otherwise: the same North, recalling what its audience may see.

## For people and for agents

- **People:** every space shows who can see it (people and agents together), each with a role; a
  space's settings list its sources ("Launch draws on: Marketing"), and adding one says who will
  newly see what; each space lists what agents know there.
- **Agents:** a short "where you are" View each turn (the space, who's present, who it acts for, its
  role, what else it may draw on and what that implies); every result carries where it came from;
  refusals say what would unblock them; `request_access({ space, reason })` asks the space's
  managers and waits.

## Paying only for what you use

The runtime gains an actor on jobs and events and one guard hook; everything else is the access
plugin.

| Level            | Who                                  | Cost                                                    |
| ---------------- | ------------------------------------ | ------------------------------------------------------- |
| 0: no actors     | CLI tools, scripts, single-user apps | none                                                    |
| 1: actors        | logins, code checks ownership itself | one `allow` call per outside call                       |
| 2: sharing       | apps with shared spaces              | a set lookup per op; SQL changes only for broad queries |
| 3: source labels | agents working across spaces         | only on writes from turns that read across spaces       |

Measured (100k documents in 1,000 spaces, latest 50; SQLite / Postgres):

| Query                                     | SQLite  | Postgres |
| ----------------------------------------- | ------- | -------- |
| one space, no rule                        | 0.06 ms | 0.35 ms  |
| one space, 500-space rule sent to SQL     | 2.9 ms  | 2.2 ms   |
| all mine, 10 spaces                       | 0.29 ms | 0.66 ms  |
| all mine, 500 spaces, OR chain            | 8.7 ms  | 19 ms    |
| all mine, 500 spaces, one array parameter | 4.4 ms  | 10 ms    |

So: queries that name their space (nearly all reads) are checked in the owner and sent unchanged;
broad queries send reach as one array parameter; reach is cached per actor and dropped exactly when
a membership changes; writes and agents' reach are set lookups; labels cost nothing within one
space.

## Connections

- **Every connection is someone.** Our own workers are the system and may act for anyone (they run
  work started by anyone). Anything else is exactly its person, checked on every read and write,
  even a browser running the whole runtime: trust comes from who it is, not from its code.
- **Two ways to prove it:** our workers show the deployment secret (compared in constant time);
  everything else shows a credential stored in the database (a session, an API key, a computer's
  key), revoked by deleting it. The plugin that knows a credential says who it proves: its `who` for
  an HTTP request (asked once per request, the answer kept a few seconds), a worker kind's `admit`
  for a computer's connection. A browser's socket shows a one-time ticket that `/connect` gave for
  its cookie. TLS to the configured address proves the owner.
- **Browsers** sign in with Google once: the sign-in route (`/signin/google`) calls the sign-in
  Action (it verifies the person and starts a session), then sets the session as an httpOnly, Secure
  cookie through the runtime (`ctx.cookies`). Sign-in methods are plugins; the runtime knows
  cookies, and identity knows sessions. Email sign-in (`emailSignIn`) is another: its routes call
  its Actions the same way, and its secrets (password hashes, codes, links' tokens) are the system's
  alone, hashed or sealed, never in the log.
- **What a browser may do:** read directly under the rules, watch queries, write directly where a
  rule speaks for the collection's writes, and call Actions for everything else it changes (a
  message's `from` pinned to the person), including what rules can't express (several documents kept
  consistent, side effects, secrets). It can't hold a transaction open: batches commit in one
  request. It never receives secret fields.

## Developer keys

Agreed and built 2026-11-06. A key is how code outside the app acts as someone, over the REST API or
the socket (`Authorization: Bearer <key>`).

- **A key is its person,** with two more fields: `{ kind: "person", id, key, scope }`. So every
  `allow` keeps working: `people` lets it in, and `inPerson` keeps it out of what a person must do
  themselves.
- **It reaches through its membership.** A key is a member of the space it was made in (`key:<id>`),
  as an agent is, and reaches what both its membership and its person reach. It has no org role, so
  even an admin's key reaches only its space, at its role. Its role follows from its scope: an
  editor when the scope calls an Action or writes, else a viewer, and never more than its person may
  be there. Keys show among the space's members, where its managers revoke them.
- **Its scope says what it may ask for:** `call`, `query`, `view`, `read` and `write`, each a list
  of exact names. The lists are typed because names collide across kinds (`message` is a collection
  and a View); there are no wildcards, so a key never quietly gains an Action a plugin adds later.
  Every key has one.
- **The runtime checks the scope only where a call from outside comes in** (`inScope`): beside an
  Action's `allow`, before a query, a View rendered for it, and its direct reads and writes. A key
  can't emit an event from outside. It's never checked in `guard` or inside jobs: an Action the key
  may call writes `message`, `thread` and usage as usual, so the scope gates what the key may ask
  for, and the rules gate what anything may touch.
- **A key names its space** (`in`) where an Action takes one: there's no default, so REST and the
  socket behave the same.
- **Making one:** the person picks the space (the one they make it in), a preset (Chat: an editor
  that sends and reads chats; Read only: a viewer that reads them) or a custom pick from what the
  app offers, and a name; the secret shows once. Apps may add presets (`apiPresets`). `GET /api/`
  shows a key what it may use.
- **Ending one:** `api_key.revoke` (its person, or a manager of its space) ends the key, its
  membership and its connections at once. Its person leaving the space or the org ends it too.
- **Not reused for other narrowed actors:** an MCP server's or an agent's tool list says what a
  model is offered, and a routine's grants are a person's consent. A scope is for a credential a
  third party holds.

## Built (2026-10-28)

The runtime's part: actors on calls, queries, events (stored with them), Processor deliveries,
timers and observed Views; `allow` on Actions; the `guard` hook, applied by the owner to every op an
actor's work makes (reads and deletes ANDed with the rule, inserts and what updates leave checked);
`ctx.as(actor)` / `ctx.as()` with `via`; constant-time key comparison. See
`runtime/tests/actor.test.ts`.

The access plugin's first part, `spaces` (`plugins/access`):

- **Spaces and members are documents** (`space`, `member`: `person:ana` → `launch`, role `editor`),
  not edges: every change is an event (the audit trail), reads are cached by the owner, and observed
  Views follow them like any data.
- **Reach** walks memberships one query per level: the spaces you're in, then the spaces those draw
  on, each with the verbs the roles along the path allow (`viewer` read, `editor` +write, `manager`
  +manage; more in the `roles` resource). An agent acting for someone (`actor.for`) reaches what
  both reach.
- **Rules:** collections listed in the `shared` resource keep to reach (their documents' `in`, or
  another field); a document shared on its own (a member `on` its collection) is reached through its
  own members. A query naming a space it reaches goes to the store unchanged.
- **Actions:** `space.create`, `space.personal`, `member.set`, `member.remove` (managers only).
- **Invitations:** people join a shared space by accepting an invitation to the email they signed in
  with (`invitation.send` by its managers, `invitation.accept`, `invitation.decline`, which its
  managers use to take one back); `member.set` changes a person's role once they're in, and lets
  agents and spaces in. Sending answers the same whether the address has an account; invitations are
  read by the space's managers and whom they're to (the identity plugin's `person.email`, the
  address a sign-in verified); each person reads only their own `person` record.
- **A Personal space is its person's alone:** only agents join it (to work there for them). Inviting
  a person or a space into it, granting a request for it, or asking into it (`request_access`) is
  refused: working with others is what shared spaces are for.
- **Moving a conversation** (`chat.move`, `/move <space>`): a person who may write in both spaces
  moves it with everything in it (messages, files, the subthreads agents opened) in one commit, or
  none of it; the rules check both ends. Answers marked as drawing on other spaces keep their marks;
  forks and the memories learned in it stay. Not while an agent is writing in it (a running turn
  writes where the conversation was when it started; a waiting one reads it again when resumed).
- **Views follow reach:** what the rules read for an observed View counts as its reads, so being let
  in or removed changes what it shows at once.
- **Measured** (`examples/access-bench.ts`, 100k notes in 1,000 spaces, latest 50 through the
  runtime): with the owner's cache, rules add under 0.2 ms even for a member of 500 spaces;
  uncached, everything for a member of 500 spaces is 5.4 ms on SQLite, 5.2 ms on Postgres.

Also built:

- **Conversations live in spaces:** chat's threads and messages carry `in`; everything written in a
  thread stays there. The terminal acts as its person (`terminal({ actor, space })`); `/space`,
  `/invite`, `/spaces`, `/work`. Agents get a "where you are" context (the space, its members, what
  it draws on).
- **Identity** (`identity`): people; credentials kept as SHA-256 hashes of their secrets, shown once
  (sessions; keys were credentials too until 2026-11-06, and are now the api plugin's, each with a
  scope); `credential.actor` says who a secret proves, which identity's `who` asks for a request's
  session cookie; revoking is deleting. Each person sees only their own credentials.
- **Google sign-in** (`google`, with `clientId`): `google.sign-in` verifies an ID token (RS256 on
  WebCrypto: Google's keys by `kid`, `iss`, `aud`, `exp`, verified email), finds or makes the
  person, and starts a session; its route sets it as an httpOnly, Secure cookie. Google's keys are a
  port (`googleKeys`), fetched through `ctx.fetch` and kept per Cache-Control.
- **Email sign-in** (`emailSignIn`, with `email`, the app's email port), built 2026-11-06: an email
  and a password; a sign-up confirmed by a code (the person made only then: `person.email` stays an
  address someone proved), resets by code that end the other sessions, invitations by link that
  trusted code asks for, and an import that keeps another app's hashes. An address someone proves is
  the person a sign-in already verified it for (a Google sign-in's). Every refusal says the same for
  an address nobody has; codes, tries and callers are limited.

- **Agents are members:** each agent on its own (`agent:maya`), a viewer or an editor, never a
  manager; an editor answers where it's a member, a viewer only reads there. A new space starts with
  the app's default agents, the first answering its new chats (`space.agent` changes which). Chat
  asks who answers in a space through its optional `roster` resource (`space.roster`), so only they
  answer, are mentioned or messaged there (`not_here` otherwise); without spaces, chat reads nothing
  for it. People make agents with the team plugin (`agent.create`, kept in its `agent` collection,
  which it shares as `{ member: "agent", write: "manage" }`, and tells chat about through chat's
  `agentSources`): one belongs where it was made, whose managers change it, and is read wherever it
  works; a manager adds an agent they've met (one the app declares, or one that belongs to or works
  in a space they reach). Removed, it leaves every space. Reading an agent labels nothing: it's
  meant for everywhere it works. A turn acts as its agent for its person
  (`{ kind: "agent", id, for, at }`), reaching what both reach.
- **Labels:** the owner keeps, per job, the labels of what it read (a document's space and its
  sources) and hands them to each insert or replace (the runtime's `labels` hook). In a collection
  with `labels: true`, a document written into a space whose members can't all see some of them (not
  the space, nor one it draws on) carries them as `sources`; reading or changing it then needs them
  all reached (`sources: { $not: { $elemMatch: { $nin: reached } } }`, a new operator in every
  store). An agent writing such a thing anywhere but where it works (`at`), or where labels aren't
  kept, is refused with `needs_share`. `share` (a person reaching every source and writing there)
  clears them. In the terminal, such a message says "uses Finance: not everyone here can see it",
  and `/share` shows it. Updates keep a document's labels as they are.

- **Memory homes:** a memory lives in the space it was learned (`in`, from its conversation); the
  memory contexts (core memories, relevant ones each turn) and `recall` keep to the conversation's
  space. To look elsewhere, `recall` takes `in`: a space the agent can read for its person, from the
  `elsewhere` context (each turn, the other spaces it can read for them, their Personal space
  first). What it brings from there labels the answer, like any read, so it only looks when it needs
  to: searching every space by default would label answers with whatever came up loosely. The list
  is a turn context (told after the conversation, again only when it changes), so a new space or
  member never costs a conversation its cached prompt. Updating a similar memory only matches one
  learned in the same space.

- **Asking for access:** agents have `request_access({ space, reason })`, which leaves a request for
  the space's managers (found by name); they see it (`request.open`, `/requests`) and grant it with
  a role or deny it (`request.grant`, `request.deny`, `/grant <n> [role]`, `/deny <n>`). It doesn't
  wait yet: the person asks again once let in.

Next: the browser's connection; labels for updates; a request that waits (with chat's waits);
memories about a person that follow them into chats where they're the only person.

## Open

- Does org membership reach inside its spaces? Proposed: org admins reach every space; members only
  theirs, plus spaces marked open to the org. Roles declare whether they pass down.
- Default in shared chats: show the restricted answer at once with Share (proposed), or ask first.
