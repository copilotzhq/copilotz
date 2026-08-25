# Dispatch Scheduled Message Action

## What it is

An Action that turns one typed scheduled occurrence into a Core Message.

## Why it exists

The generic Schedules plugin cannot depend on Core participants, threads, or
Messages.

## How to use it

The Schedule Core due-event Processor invokes this Action automatically.

## How it works

It resolves or creates participants and a thread, creates the Message in one
transaction, and returns the durable Message and Thread identifiers.
