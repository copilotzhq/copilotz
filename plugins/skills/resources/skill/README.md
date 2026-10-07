# Skill Resource

## What it is

An immutable manifest, file index, and lazy file reader for one Agent Skill.

## Why it exists

Skill content must be portable, bounded, and inspectable without eagerly loading
every file.

## How to use it

Use `defineSkill` from `@copilotz/copilotz/skills`: pass `root` for a local or
HTTP(S) directory, or `markdown` and an optional `files` map for embedded
content. Register the result under `resources.skills` using the manifest name.

## How it works

The definition validates frontmatter, paths, descriptors, and lazy reads while
snapshotting all declarative data.
