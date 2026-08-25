# Delete Thread Messages Action

## What it is

Deletes all Messages currently stored for one Core Thread.

## Why it exists

Thread clearing requires a durable, transactional domain operation.

## How to use it

Invoke `deleteThreadMessages` with the target Thread ID.

## How it works

It queries the Thread's Messages and deletes each record in one transaction.
