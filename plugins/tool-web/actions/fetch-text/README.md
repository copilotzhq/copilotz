# Fetch Text Action

## What it is

An HTTP text-fetching Action with bounded filtering and extraction.

## Why it exists

Agents often need a small relevant text slice instead of an entire response.

## How to use it

Grant the matching `fetch_text` Tool after composing the Web Tools plugin.

## How it works

It fetches text with cancellation and timeout support, then optionally filters
lines or applies a bounded regular expression before truncation.
