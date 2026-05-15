# How Resource Loading Works

`createCopilotz(...)` loads resources from configured paths, merges them with
built-in resources, normalizes them, and turns them into runtime config.

## What Happens During Loading

1. Copilotz reads configured resource paths.
2. It discovers supported resource folders such as `agents`, `tools`,
   `features`, and `collections`.
3. It merges project resources with built-in resources.
4. It normalizes the final config used by the runtime.

## Why This Matters

If you understand resource loading, you can predict:

- where code should live
- whether a capability will be available at runtime
- why a route, tool, or collection appears or does not appear

## Recommended Use Case

Use resource loading as the primary composition mechanism for application
behavior.

## Common Mistaken Alternative

Do not rely on giant inline config objects when the behavior belongs in a
resource directory. File-based resources are the canonical structure.

## Related Pages

- [Resources Are the Foundation](../start-here/resources-are-the-foundation.md)
- [createCopilotz](../reference/create-copilotz.md)
- [Resources](../resources/README.md)
