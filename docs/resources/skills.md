# Skills

Skills are structured instruction assets that can be discovered and loaded at
runtime.

## Where It Lives

```txt
resources/skills/<skill-name>/
  SKILL.md
```

## What It Is For

Use a skill when you need reusable instructions or workflows that can be loaded
progressively.

Recommended use case: reusable instruction bundles  
Most common mistaken alternative: duplicating long instructions in every agent

## How Copilotz Consumes It

- skills are loaded into the skill registry
- built-in tools can list, load, and read skill resources
- agents or workflows can consume them when appropriate

## Minimal Example

The built-in skill directories under `resources/skills/` are the canonical
reference.

## Public Surface

Skills are accessible through runtime tools and skill-loading workflows, not
directly as feature endpoints.

## Related Pages

- [Tools](./tools.md)
- [What Is Copilotz?](../start-here/what-is-copilotz.md)
- [createCopilotz](../reference/create-copilotz.md)
