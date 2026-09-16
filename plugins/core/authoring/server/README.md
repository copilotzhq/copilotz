# server

## What it is

Core conversation HTTP composition and its ordinary mutation Actions.

## Why it exists

Give applications one reusable conversation boundary while retaining stored
Collections and Events.

## How to use it

Compose `coreServerPlugin` with `corePlugin` and `serverPlugin`. Supply
authentication, authorization, and exposure policy through
`resources.server.default`, using `defineServerFacade`.

## How it works

Exact HTTP adapters project history and capture conservative replay boundaries
before reads. Mutations use existing Core Actions and authenticated actor
metadata.
