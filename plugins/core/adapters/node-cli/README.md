# Node CLI Adapter

## What it is

The Node-compatible terminal host for Core's portable CLI loop.

## Why it exists

Readline and process streams are host capabilities and cannot live in portable
Core.

## How to use it

Import `startInteractiveCli` from `/core/cli/node`.

## How it works

It adapts Node readline, stdin, stdout, cwd, completion, and clearing to
`InteractiveCliIo`.
