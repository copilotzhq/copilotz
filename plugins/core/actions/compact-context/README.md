# Context compaction

## What it is

The durable foreground Action that waits for a certified conversation history
boundary to advance.

## Why it exists

An Agent whose input exceeds its budget must consolidate memory before
answering. Its ordinary Action lifecycle supplies reconnectable progress without
exposing private maintenance content.

## How it works

The Action verifies the Agent participant, delegates to the configured context
resource with scoped capabilities and cancellation, and completes only after the
resource reports progress. The router reloads history and checks its budget
again. Core supplies the history capacity remaining after the prepared prompt
prefix and one configured model response; contributors budget their own task
suffix within that capacity. Background maintenance does not invoke this Action.

## How to use it

Core invokes this Action internally when preparing an oversized conversation
request. Applications install their context resource through the existing plugin
composition; they do not expose this Action as a public HTTP mutation.
