# Complete Ask Processor

## What it is

Resumes a deferred Ask from the asked Agent's final Message.

## Why it exists

An Agent answer is asynchronous Tool-plan completion, not an open Action
promise.

## How to use it

It is installed by Core and matches Ask answer Messages.

## How it works

It validates sender ownership and attaches the answer Message reference and
content to the waiting branch.
