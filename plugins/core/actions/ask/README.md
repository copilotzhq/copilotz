# Ask Action

## What it is

A durable Action that delegates one question to another Agent.

## Why it exists

Nested and parallel Agent work needs the same future and fan-in semantics as
Tools.

## How to use it

Grant the `ask` Tool and provide `target`, `message`, and optional
public/private mode.

## How it works

It creates a directed canonical question Message and defers its Tool-plan branch
until the asked Agent settles.
