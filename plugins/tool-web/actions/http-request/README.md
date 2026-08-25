# HTTP Request Action

## What it is

A bounded general-purpose HTTP Action.

## Why it exists

Agents need explicit network access with controlled response size and timeout.

## How to use it

Grant the matching `http_request` Tool after composing the Web Tools plugin.

## How it works

It validates the URL, propagates cancellation, enforces a timeout and response
limit, and returns structured status, headers, and body data.
