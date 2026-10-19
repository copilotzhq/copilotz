# server

## What it is

Core conversation HTTP composition and its ordinary mutation Actions.

## Why it exists

Give applications one reusable conversation boundary while retaining stored
Collections and Events.

## How to use it

Compose `coreHttpPlugin` with `corePlugin` and `serverPlugin`. Supply
authentication, authorization, and exposure policy through
`resources.server.default`, using `defineServerFacade`.

## How it works

Exact HTTP adapters project history and capture conservative replay boundaries
before reads. Mutations use existing Core Actions and authenticated actor
metadata.

## Restricted participant display

Applications whose participant records contain private fields can replace the
registered `adapters.http.core` value with
`createCoreHttpAdapter({ participantDisplayQuery: "threadDisplay" })`, exported
from `@copilotz/copilotz/core/server`. The named participant Collection query is
a trusted startup setting. It is never selected from HTTP input.

Declare that owner projection using `participantDisplayInputSchema` and
`participantDisplayOutputSchema`. Each list/get/history route supplies its exact
thread ID and a fixed `participants` or `senders` purpose. A route selection of
at most 1,000 unique IDs is read in sequential batches of four, within the
existing owner-projection input budget even for maximally escaped IDs. A failed
batch refuses the complete response. The owner query must check current viewer
thread/Space access and actual enrollment or stored-message sender
relationships. Historical display does not grant execution authority or require
a removed sender's current tool or Agent registration. The output includes only
the declared display fields, empty metadata, and the authorized namespace; email
and arbitrary extra fields are refused. Every requested ID must appear exactly
once. Query failure or malformed output fails the request without falling back
to unrestricted participant reads.

The default `coreHttpAdapter` retains its existing application-authorized direct
participant reads. Observation continues to authorize the selected thread
through its existing read boundary; it does not acquire participant display
privileges.
