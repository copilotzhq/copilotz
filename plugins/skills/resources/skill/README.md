# Skill Resource

## What it is

An immutable manifest, file index, and lazy file reader for one Agent Skill.

## Why it exists

Skill content must be portable, bounded, and inspectable without eagerly loading
every file.

## How to use it

Use `defineSkill` for an external loader or `defineInlineSkill` for embedded
content.

## How it works

The definition validates frontmatter, paths, descriptors, and lazy reads while
snapshotting all declarative data.
