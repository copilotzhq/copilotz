# Plugin ownership and layout audit

## Completed structure

- Core owns its collections, Actions, Processors and Tool authoring. The
  `core-collections` and `tools` roots and their export shims are removed.
- Optional Tool providers stay independent. OpenAPI and MCP contracts live with
  their owning providers.
- All 23 concrete roots compose through generated declarations. Manifest
  `plugins: [{from, export}]` replaces dependency forwarding directories.
- Plugin `internal` and `dependencies` directories are removed. The build
  rejects those conventions and excludes `shared` from discovery.
- A single-primitive helper sits in that primitive's module. `shared` is
  reserved for real reuse across different primitives. Public authoring APIs
  stay under `authoring`.

## Ownership evidence

The initial inventory contained 119 production helper/dependency files. After
Core consolidation and provider-contract separation, import-symbol resolution
was used to follow direct and transitive consumers, including worker URL
imports. Tests, test support and re-export-only barrels do not count as
primitive owners. 141 helper, test and support files were relocated. The final
inventory contains 71 production `shared` modules, each with at least two
distinct primitive owners.

Representative decisions:

| Module family                                          | Location and reason                                                           |
| ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Core action validation, history and Tool-plan helpers  | Core `shared`; reused by Actions and Processors.                              |
| Core Agent instruction rendering                       | Message Router module; one Processor owns it.                                 |
| Core capability resolver and public types              | Core `authoring/capabilities`; explicit public authoring API.                 |
| LLM request execution, HTTP and provider orchestration | Bridge Adapter module.                                                        |
| Channel provider transport and contracts               | Respective provider Adapter module where it is the sole consumer.             |
| Memory input, access, retrieval and source policy      | Memory `shared`; multiple Actions, Processors and Resources use them.         |
| Memory proposal and commit helpers                     | Consolidate Memory Action module.                                             |
| Knowledge chunker                                      | Index Document Action module.                                                 |
| Finance clients and providers                          | Finance Action module.                                                        |
| Tool serialization and generated alias helpers         | Core shared authoring support with public exports used by optional providers. |

Generic runtime tests use a test-only storage primitive fixture. It is excluded
from publishing and does not reintroduce a production compatibility plugin.

No plugin factory wrappers, runtime discovery, or new dependency registries are
introduced. Production freezing wrappers and their redundant recursive walks
have been removed; required snapshot copies remain.
