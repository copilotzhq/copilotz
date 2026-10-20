# server

## What it is

Core conversation HTTP composition and its ordinary mutation Actions.

## Why it exists

Give applications one reusable conversation boundary while retaining stored
Collections and Events.

## How to use it

Compose `coreHttpPlugin` with `corePlugin` and `serverPlugin`. Supply
authentication and exposure through `resources.server.default`, using
`defineServerFacade`. Configure authorization in the application's
`authorization: OwnerAuthorization`. Bind `thread`, `participant` and `message`;
Server startup names any missing binding.

## How it works

Exact HTTP adapters project history and capture conservative replay boundaries
before reads. Mutations use existing Core Actions and authenticated actor
metadata.
