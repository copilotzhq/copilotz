# Knowledge embedding resource

## What it is

A typed resource definition for an embedding provider.

## Why it exists

It keeps provider-specific vector generation outside Knowledge Actions and
durable data.

## How to use it

Register the resource in the application's `embedding` adapter map and reference
its ID in Knowledge configuration.

## How it works

The helper validates and freezes the embedding boundary, while Actions resolve
it by ID and validate returned vectors.
