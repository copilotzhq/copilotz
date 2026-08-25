# Open Skills Builder

## What it is

A Deno-hosted compiler from Skill directories to a portable plugin module.

## Why it exists

Filesystem discovery belongs in a host-specific entrypoint, while generated
Skill Resources remain runtime-neutral.

## How to use it

Import `buildOpenSkillsPlugin` from `@copilotz/copilotz/skills/deno`.

## How it works

It validates immediate Skill directories, packs their files, and writes a module
that reconstructs immutable inline Skill Resources.
