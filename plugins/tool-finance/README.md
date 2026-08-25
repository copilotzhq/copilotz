# Finance Tool Plugin

## What it is

A concrete Tool plugin that provides bounded market and company data through a
swappable Finance provider.

## Why it exists

Applications need one composed Action and data-only Tool Resource for finance
queries while keeping provider implementation private and replaceable.

## How to use it

Create it with `createFinanceToolsPlugin({ getProvider })` and compose the
result into an application.

## How it works

The plugin composes the Finance Action with its immutable Tool Resource. The
Action selects the configured provider and the Resource presents its schemas to
LLM agents.
