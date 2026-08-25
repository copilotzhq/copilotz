# Web Channel Resource

## What it is

The data-only policy for a Web Channel alias.

## Why it exists

Channel routing policy must be inspectable without exposing Adapter behavior.

## How to use it

Create it directly or through `createWebChannelPlugin()` with default Agent
aliases and metadata.

## How it works

It snapshots request-observation egress policy through the shared Channel
Resource validator.
