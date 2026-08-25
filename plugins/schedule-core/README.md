# Schedule Core

## What it is

Schedule Core connects generic durable Scheduled Jobs to Core conversations and
exposes the `scheduled_jobs` Tool.

## Why it exists

Generic scheduling should not depend on conversation concepts. This plugin owns
the explicit bridge that turns typed due occurrences into Core Messages.

## How to use it

Install `coreSchedulesPlugin` or import the public helpers from
`@copilotz/copilotz/schedules/core`. The plugin composes Core and Schedules as
dependencies.

## How it works

The due-event Processor invokes a transactional dispatch Action. A separate
Action and Tool Resource let Agents create, inspect, update, pause, resume,
cancel, and manually run Core scheduled-message jobs.
