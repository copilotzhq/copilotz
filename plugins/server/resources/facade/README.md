# Server Facade Resource

## What it is

An immutable process-local definition of the HTTP facade's path, exposure,
override, and authorization policy.

## Why it exists

HTTP policy belongs in application composition rather than runtime internals or
source-directory naming conventions.

## How to use it

Call `defineServerFacade(...)`, normally through `createServerPlugin(...)`.
Omitting exposure and guard options enables every eligible primitive in the
application's default scope.

## How it works

The helper validates and snapshots declarative configuration while retaining the
typed guard hook as a process-local Resource policy.
