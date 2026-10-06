# OpenAPI

Declare `defineApi({id,name,schema,operations?,auth?...})` under
`resources.apis`. The resource contributes tools and its default binding
automatically. Use `transformTool` for application execution or presentation
customization. See
[APIs and tools](../../docs/getting-started/part-2-capabilities/07-existing-apis-and-tools.md).

Use `aliases: { operationId: "applicationAlias" }` when an application's native
Action names differ from the OpenAPI operation IDs. Request preparation,
response mappings and `transformTool` still receive the original operation
identity. Aliases must be unique. `transformTool` can wrap a generated executor
or customize its schema and presentation once, without a second compiler or
registration pass.
