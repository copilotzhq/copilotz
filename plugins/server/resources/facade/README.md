# Server Facade Resource

## What it is

A process-local definition of the HTTP facade's path, exposure and
authentication.

## Why it exists

HTTP configuration belongs in application composition. Authorization is
evaluated by the owner through the application's
`authorization: OwnerAuthorization`.

## How to use it

Call `defineServerFacade({ authenticate, expose })` and provide the result as
`resources.server.default`. Authentication must return a scope with retained
`authority` or a rejecting `Response`. Server startup requires application
authentication; the plugin's placeholder cannot serve requests. Omitted exposure
options include every eligible primitive; startup requires bindings for exposed
Collections and Actions and adapter-declared Collections.

## How it works

The helper validates and snapshots declarative configuration and retains the
process-local authentication callback. Owner policy evaluates each use. Ambient
`app.actions` and `app.collections` calls inside handlers carry caller
authority; startup and other host code remain trusted.
