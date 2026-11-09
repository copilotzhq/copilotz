# @copilotz/team

Agents people make, and the models an org's agents think with, for
[Copilotz](https://github.com/copilotzhq/copilotz): two plugins beside its `chat`, whose agents are
the app's own, in its code.

```sh
npm install @copilotz/team copilotz          # Node 24+, Bun
deno add jsr:@copilotz/team jsr:@copilotz/copilotz
```

It goes with Copilotz at the same version (they're released together): `@copilotz/team@x.y.z` with
`copilotz@x.y.z`.

```ts
import { team, tiers } from "@copilotz/team";

const runtime = await createRuntime({
  store,
  plugins: [models, chat, ...access, team, tiers, app],
});
```

```ts
// In the browser, beside the web shell's and spaces' front ends:
import { teamWeb, tiersWeb } from "@copilotz/team/web";
```

| Import                    | What it has                                                                   |
| ------------------------- | ----------------------------------------------------------------------------- |
| `@copilotz/team`          | `team`, `tiers`                                                               |
| `@copilotz/team/web`      | `teamWeb` (an agent's page, making one, adding one to a space), `tiersWeb`    |
| `@copilotz/team/contract` | their shapes (`AgentDoc`, `ModelPick`, `Tier`, `Shown`…), for plugins on them |

- **`team`**: agents people make where they belong (a space), with their instructions, tools and
  model, added to other spaces by those who've met them, changed only by who manage the space they
  belong to; removed, one leaves every space it worked in. Its collection is `agent`; chat asks it
  what an agent not in the app's code is (the `agentSources` resource).
- **`tiers`**: which model each of the app's agents thinks with, by tier ("Everyday", "Expert"): the
  first that applies of a space's pick, the space's tier, the org's pick, the org's tier and its
  plan's (the `planTier` resource, which `@copilotz/billing`'s credits fill). Its collection is
  `modelChoice`; chat asks it through the `agentModel` resource.

Its front end's words are `team.<key>`: see
[WORDS.md](https://github.com/copilotzhq/copilotz/blob/main/packages/team/WORDS.md).

Through 1.0.0-rc.32 these were `team` and `tiers` in `copilotz/plugins/agents`, and `teamWeb` and
`tiersWeb` in `copilotz/plugins/agents/web`. Their names (collections, Actions, events, Views,
resources) are the same, so an app's data stays as it is: only its imports change. See
[design/plugins.md](https://github.com/copilotzhq/copilotz/blob/main/design/plugins.md).
