# Knowledge tools

## What it is

Static Tool declarations.

## Why it exists

Applications can choose individual capabilities without a plugin factory.

## How to use it

Import
`ingestKnowledgeDocumentTool, searchKnowledgeTool, deleteKnowledgeDocumentTool`
and register selected declarations in `resources.tools`.

## How it works

Each declaration contributes a native Action and a data-only Tool Resource
through the synchronous composition protocol. Configuration is read from the
final context.
