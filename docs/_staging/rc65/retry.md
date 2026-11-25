# rc.65 staging: nested-call ids that name their caller

Not a page. The release commit copies (a) into `CHANGELOG.md` and (b), (c) into `AGENTS.md`.

## (a) CHANGELOG entry

rc.64's **Known issues** are both fixed, so rc.65's entry has no Known issues. Its intro may say
that a retried Action finds the nested calls it completed, wherever it makes them.

Under `**Fixed, here since rc.63 or before:**`:

- **A retried Action finds the nested calls it completed.** A nested call's id names its caller, the
  Action, how many calls of it with the same input the caller made before, and its input's hash
  (`<caller>.<action>#<n>.<inputHash>`), instead of its place among all the caller's calls. Calls of
  other Actions or inputs, refused or allowed on the retry, added, or started in another order, no
  longer make a completed call run again. Identical calls are matched in the order they're made: the
  same call made twice is still two calls, and an identical call made earlier takes the lower
  number. A call a synchronous `allow` refuses takes no number, as before, so the same call made
  next through a grant is found whichever way the permission went; one an asynchronous `allow`
  refuses keeps the number it took before waiting.
- **Two Processors handling one event keep their calls and timers apart.** A delivery's calls are
  named under `<event>:<processor>`, and its timers are `<event>:<processor>:timer.<n>`. One
  Processor's call is no longer answered from another's record, and one's timer no longer replaces
  another's. An unrecorded Action's calls are named under its caller's Processor or branch.

Under `**Docs:**`:

- The reference has "Nested calls and retries" under Actions. The stores page says how to see work
  in flight.

Under `**Upgrading:**`:

- **Finish work in flight before upgrading.** Nested-call ids change form, and rc.65 doesn't read
  the records rc.64 kept under the old ones. Work in flight is a Processor delivery not yet done, or
  a call that started, didn't complete, and will be called again with the same id (by a client, a
  webhook sender, or a timer's retry). Retried on rc.65, its nested calls that completed on rc.64
  run once more, with all they do (writes, emits without an `id`, outside calls), and timers are set
  a second time: a Processor's (renamed `<event>:<processor>:timer.<n>`) and a nested call's. An
  Action's own timers keep their ids. Wait for `runtime.idle()`, stop with
  `runtime.close({ drain })`, check what's left
  ([work in flight](docs/operations/stores.md#work-in-flight)), then start rc.65, its owner and
  executors together. Rolling back to rc.64 with work in flight does the same in reverse.
- **Nested-call ids change form.** Code that read a position from an id must read `cause` and
  `data.action` instead.
- **A Processor's name is part of its calls' ids.** Renamed, a Processor replays the log from the
  start, as before (its position is kept by name), and its nested calls now run again for every
  event it replays; rc.64 answered them from the records left under the event. Keep `/` and `:` out
  of Processor names and branch keys: they join a caller's parts.

## (b) AGENTS.md text

Section **"Rules: do this, not that"**, after the bullet that starts `**Outside effects:**`, add:

```markdown
- **Nested calls on a retry:** a retried Action or delivery (`ctx.retry`) gets each `ctx.call` that
  completed back from its record, wherever in the code it's made; identical calls are matched in the
  order they're made. Keep a nested call's input the same across attempts (no clock or random id
  made inside it), and put who it's for in it when the same call is made for several people
  (`ctx.as(person)`). Don't call a failed Action again in a loop of your own: let the failure fail
  the caller, and retry the caller. Use `ctx.branch(key)` to keep identical calls of concurrent work
  apart.
```

## (c) "Find it" lines

Section **"Find it"**, group **"Actions, access and mail"**, after the line that starts
`- Group several writes inside an Action`:

```markdown
- Make nested calls safe to retry → `ctx.call`, `ctx.retry`, `ctx.branch(key)` →
  [Nested calls and retries](docs/reference.md#nested-calls-and-retries).
```
