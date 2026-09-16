# Define Tool

## What it is

A helper for defining either a data-only Tool Resource over an existing Action
or a compound Action-plus-presentation declaration.

## Why it exists

Developer-facing Tool syntax should be concise without putting executable
callbacks inside the published Tool Resource.

## How to use it

Call the positional form for a hand-authored Action, or the object form before
registering the declaration directly in `resources.tools`.

## How it works

The helper validates and freezes schemas, history policy, and metadata. Object
form creates an ordinary Action and retains its presentation separately.
