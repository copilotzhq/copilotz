# Space attachment

## What it is

One durable association between a collection record and a Core Space.

## Why it exists

Core and application-defined records can share context without a product-type
registry or adding a Space field to each schema.

## How to use it

Use `actions.spaces` with `attach` or `detach`. Supply the registered collection
alias and record ID. `spaceAttachment.queries.bySpace({ spaceId })` lists
records.

## How it works

The stable ID encodes the canonical collection name and record ID; namespace is
provided by the runtime. The schema validates that identity, so alternative
aliases cannot create extra attachments. A generic graph relation connects the
attachment to its record. Moving updates the Space relation in one transaction.
Archived attachments stay attached unless explicitly moved or detached;
restoring an old Space never takes back a record that has moved elsewhere.
