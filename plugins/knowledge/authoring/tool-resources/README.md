# Knowledge tool authoring

## What it is

A composite helper that produces Knowledge Actions and their matching Tool
Resources.

## Why it exists

It keeps generated, model-facing aliases in one implementation owner rather than
duplicating them across primitive folders.

## How to use it

Configure `tools` in `createKnowledgePlugin`, or call
`createKnowledgeActionResources` with embedding and alias options.

## How it works

The helper validates distinct aliases and returns frozen Action and Tool maps
sharing the exact same Action definitions.
