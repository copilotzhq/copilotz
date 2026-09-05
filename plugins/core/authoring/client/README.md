# client

## What it is

Typed conversation client over the shared browser HTTP client.

## Why it exists

Keep known conversation types and method names out of application transports.

## How to use it

Import createCoreClient from @copilotz/copilotz/core/client and pass
createCopilotzClient({ baseUrl: "/api" }).

## How it works

Reads use canonical conversation endpoints. Mutations submit ordinary Actions;
observations delegate multipart and checkpoint handling to the generic client.

Read conversation content with
`core.messages.asset(threadId, messageId, assetId, { signal })`. The returned
Fetch Response preserves binary bodies and content headers; authorization is
bound to that exact message reference.
