# Participant Collection

The built-in `participant` collection represents durable identities used across
threads and runtime workflows.

## What It Holds

- identity fields such as `externalId`
- participant type such as `human` or `agent`
- metadata owned by the application

## Recommended Use Case

Use `participant.metadata` as the durable user profile and long-term context
store when the data belongs to the user identity.

## Common Mistaken Alternative

Do not maintain a separate profile store unless you have a strong, explicit
reason to split the contract away from the participant identity model.

## Public Surface

The participant collection is reachable through collection routes and through
the collections manager.

## Related Pages

- [Persist User Context with Participants](../playbooks/persist-user-context-with-participants.md)
- [Collections API](./collections-api.md)
- [How Threads Work](../runtime/how-threads-work.md)
