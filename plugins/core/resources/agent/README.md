# Agent Resource

## What it is

An immutable process-local Agent definition with Model and capability selection.

## Why it exists

Agent policy should be declarative while allowing a pure per-turn instruction
hook.

## How to use it

Call `defineAgent` and register the result under `resources.agents`.

## How it works

The helper validates aliases and deeply freezes data; Core evaluates any
instruction hook against durable turn facts before `llm.call`.
