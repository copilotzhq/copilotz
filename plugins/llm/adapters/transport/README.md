# Provider transport

## What it is

Shared endpoint construction for built-in provider protocols.

## Why it exists

It prevents equivalent URL joining logic from diverging across providers.

## How to use it

Provider adapters call `providerEndpoint` with their default service endpoint
and path.

## How it works

It normalizes an optional configured base URL before appending the provider
route.
