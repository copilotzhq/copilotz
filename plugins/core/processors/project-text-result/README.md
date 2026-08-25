# Project Text Result Processor

## What it is

Projects completed LLM output into a Message or Tool plan.

## Why it exists

Provider results need one durable semantic projection authority.

## How to use it

It is installed by Core and consumes completed `llm.call` events.

## How it works

Plain content becomes a canonical Message; Tool calls become an immutable plan
whose branches are scheduled in parallel.
