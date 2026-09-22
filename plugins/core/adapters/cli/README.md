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
reasoning, and Tool-call stream lanes. Stopping the CLI cancels the current
operation and its readers, including an operation admitted after stop. Completed
operations detach their observer. Stream EOF is not operation completion: the
CLI waits for `done` and preserves durable failures, while allowing an
individual failed model stream to be followed by a successful retry.
