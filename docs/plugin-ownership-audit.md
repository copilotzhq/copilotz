# Plugin ownership and layout audit

Date: 2026-09-15. Inspected implementation: local commit `7e06bfb`.

## Decisions

- Merge Core Collections and Tool authoring into Core; remove obsolete roots and
  export shims. Optional provider/native tool plugins remain independent.
- Eliminate plugin `internal` and `dependencies` folders. Shared code must serve
  different primitives; a single-primitive helper belongs in that module.
- Use direct manifest dependency imports instead of one-file dependency
  re-exports.
- No legacy data migration/backfill or compatibility implementation is required.
  Planning does not authorize deleting a database.

## Initial inventory

The static import/re-export triage found 119 production files in helper or
plugin dependency folders. Tests and test-support directories were excluded.
Transitive consumers were followed through helper/barrel imports. This is an
initial move-map input, not proof every helper is classified: confirm worker and
dynamic imports, ownership after the merge and public API consumers manually.

| Plugin/family    | Files |
| ---------------- | ----: |
| admin            |     3 |
| channel-core     |     4 |
| channel-discord  |     3 |
| channel-telegram |     3 |
| channel-web      |     1 |
| channel-whatsapp |     3 |
| channel-zendesk  |     3 |
| core             |    21 |
| core-collections |     4 |
| knowledge        |     8 |
| llm              |    21 |
| memory           |    15 |
| schedule-core    |     4 |
| schedules        |     6 |
| server           |     1 |
| skills           |     3 |
| tool-builtin     |     4 |
| tool-deno        |     1 |
| tool-finance     |     5 |
| tool-mcp         |     1 |
| tool-web         |     1 |
| tools            |     2 |
| usage            |     2 |

## Concrete moves and boundaries

- Core `thread-metadata`: only Message Router is a resolved production consumer;
  put it with that Processor, reviewing/removing obsolete legacy key handling.
- Core Collections action validation: used by five Actions; move to Core shared
  after the merge rather than duplicating it in each Action.
- Memory input utilities: multiple Actions, Processors and prompt-context
  Resource consumers; genuine Memory shared code.
- Channel provider transport helpers: keep with their Adapter primitive. The
  provider-options resolver has multiple provider-Adapter consumers and needs a
  deliberate Channel Core public helper surface.
- Knowledge config/input utilities: shared across indexing/search/ingest/delete
  Actions; shared is justified, but embedding and search semantics stay owned by
  Knowledge, not runtime.
- Finance provider helpers: the initial graph resolves to one Finance Action;
  place them within that primitive, subject to public export review.
- Tool lifecycle JSON helper: multiple primitive/provider consumers; determine
  whether Core authoring should publicly own the domain contract or each
  provider only needs existing generic JSON validation. Do not create a private
  cross-plugin shared import or move provider behavior into Core.
- Tools integration-resources contains OpenAPI/MCP-specific contracts. Split
  ownership to those provider plugins while moving defineTool/ToolResource into
  Core. Merging directories blindly would create new domain leaks.
- Core's llm/collections dependency files are re-export stubs, not shared logic.
  Remove the collections dependency after merging ownership; express LLM as a
  direct manifest import. Apply the same rule to other plugin dependency stubs.

## Implementation rule

For each helper, record source, owning primitive(s), public consumers and
target. A helper shared by two files inside one primitive is still
primitive-local. A transitive helper serving distinct primitives can be shared
even if only one helper imports it directly. Test files do not count as
independent production consumers. Generated files, worker URLs and public
barrels must be checked.

Keep the ownership map and the build/layout checks in sync. Shared files must
never be convention-discovered as primitive registrations. Do not add runtime
factories, service locators, automatic plugin discovery or unnecessary freezing.
