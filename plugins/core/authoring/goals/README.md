# Goal runner

## What it is

`runGoal` is a small application-level loop that alternates settled Core
Messages between a target Agent and a lead Agent.

## Why it exists

Core `send().done` already waits for the complete causal turn, including Tool
pipelines, parallel calls, nested asks, retries, and the final Message
projection. Goals reuse that boundary instead of maintaining a second workflow
state machine.

## How to use it

Create the target and lead Threads and their participants, then call `runGoal`
with one explicit recipient in each scope. Await `handle.done`, and optionally
consume `handle.events` or provide `onOutput` for live application output.

## How it works

Each target turn is one ordinary `application.send(message(...))`. Once that
send settles, the runner selects the target Agent's final resolved
`message.created` Event and sends its canonical ContentRefs to the lead Thread.
The lead reply is sent back to the target on the next turn. Messages and Action
lifecycles remain the durable record; the local loop adds no Collection, Action,
Processor, Resource, or database schema.
