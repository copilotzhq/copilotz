# Interactive CLI Adapter

## What it is

A runtime-neutral interactive renderer and input loop for Core applications.

## Why it exists

CLI presentation should consume ordinary application streams without owning
terminal APIs.

## How to use it

Provide an `InteractiveCliIo`, application, and Message scope to
`startInteractiveCli`.

## How it works

It sends one typed Message per prompt and renders independent content,
reasoning, and Tool-call stream lanes.
