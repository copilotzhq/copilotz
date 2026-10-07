# Long-term memory collection

## What it is

Stores maintenance checkpoints.

## Why it exists

Memory maintenance must be recoverable.

## How to use it

Install through the memory plugin.

## How it works

It tracks reserved and settled source ranges. Automatic reservations coordinate
through one allocation head per thread and agent. Certified continuity belongs
to that thread and agent; the recorded read/write scopes are maintenance
capabilities, not dependencies that invalidate continuity when peer access ends.
Semantic records and relations are read separately using current permissions.
