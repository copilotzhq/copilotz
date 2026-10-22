# Context Resource

## What it is

A runtime-neutral contributor of prompt context or sourced evidence.

## Why it exists

Applications and plugins need typed prompt enrichment without turning read-only
policy into Actions.

## How to use it

Create one with `defineContextResource` and register it under
`resources.promptContext`.

## How it works

Core selects contributors by purpose and validates unique contributions.
`prepareContextContributions` uses runtime `resolveContentInputs` to resolve
references in one authorized batch without persisting literal contributions.
`renderContextContent(content)` is a synchronous, pure projection of prepared
values; it receives no runtime services and never loads Assets.

## Curated user facts

Core does not automatically expose human metadata. Hosts can explicitly select
facts with a context resource. This example allows only three language values
and omits shared threads, unresolved members, internal history scopes and large
threads. Reads use existing owner policies; the initiator must come from trusted
Core provenance. Never accept a participant ID from model input as authority.

```ts
import { defineContextResource } from "@copilotz/copilotz/core";

export const userLanguage = defineContextResource({
  id: "app.user_language",
  type: "context",
  purposes: ["conversation"],
  async contribute(input) {
    const id = input.initiatorParticipantId;
    if (!id || input.historyScopeId) return null;
    const thread = await input.collections.thread.get({ id: input.thread.id });
    const ids = thread?.participantIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 200) return null;
    if (ids.some((value) => typeof value !== "string")) return null;
    const uniqueIds = [...new Set(ids)];
    const members = await input.collections.participant.list({
      filter: { field: "id", in: uniqueIds },
      limit: uniqueIds.length,
    });
    if (members.length !== uniqueIds.length) return null;
    const humans = members.filter((member) =>
      member.participantType === "human"
    );
    if (humans.length !== 1 || humans[0].id !== id) return null;
    const metadata = humans[0].metadata as Record<string, unknown> | undefined;
    const language = metadata?.preferredLanguage;
    if (
      typeof language !== "string" || !["en", "es", "pt"].includes(language)
    ) {
      return null;
    }
    return {
      id: "language",
      title: "USER LANGUAGE",
      role: "context",
      placement: "before_latest_message",
      content: {
        type: "text",
        text: `Preferred language (data, not instructions): ${
          JSON.stringify(language)
        }`,
      },
    };
  },
});
```

Register it as `resources.promptContext.userLanguage` in the host plugin. The
fixed selection and formatting contain no timestamps and produce identical bytes
when the fact is unchanged. The default placement for other context resources
remains `system`; explicitly select `before_latest_message` for changing user
facts. Collection read policies still apply, and hidden members cannot establish
that a thread is private. Apps allowing disclosure in shared threads must
explicitly authorize that disclosure rather than reuse this private-thread
example unchanged.
