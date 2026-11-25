# rc.64 review fixes

## Actions and transactions

A transaction can write both durable collections and collections declared `durable: false`. Its
reads see its earlier writes to either kind. A failed write rolls back both kinds and a
transactional Action's completion receipt. This applies to `transaction: true` and
`ctx.transaction`.

A retry of a parent Action keeps rc.63's nested call IDs. A synchronous admission refusal consumes
no position. A call with an asynchronous admission rule reserves its position before it waits.

An unrecorded Action called by a named query uses the same elevation rule as a direct call when it
reads as a grant. Watched queries apply the rule on each refresh.

A buffered `ctx.record` append uses the actor and Action that made it, including a named grant. When
the owner refuses the append at completion, a recorded Action writes a failure receipt.

## Schema generation

An Action input can embed `Infer<typeof schema>` in a field or an array. Fragment references such as
`#/$defs/text` resolve within the embedded schema.

On Deno, `gen` resolves type imports through the app's module graph, including its import map. Node
can also generate schemas from local types named by exact or prefix entries in a Deno import map. An
unresolved imported input type reports the import's file and position.

## Email reference

The capture adapter keeps messages locally. A runtime configured with a public `links.origin` and
`email.adapter: "capture"` refuses to start. For a test that needs a public-looking origin, set
`email.capture.allowPublicOrigin: true`. The setting applies only to capture. Regenerate the email
plugin reference after merging its updated settings contract.

## npm executable

The existing npm bin mapping supports Node 24.0 and 24.1. The public `/gen` entry dispatches to the
dedicated executable when launched, including through an npm symlink, and is safe to import.
