# Connect a React UI

## When to Use This

Use this pattern when your frontend should consume Copilotz threads, messages,
participants, collections, or feature endpoints through a web UI.

Recommended primitive: thin frontend services over Copilotz-backed routes  
Most common mistaken alternative: leaking raw runtime concerns into UI
components

## Recommended Flow

- use `copilotz-starter` as the base app example
- keep the web UI focused on transport contracts
- normalize participant-backed state in the frontend instead of duplicating the
  backend model

## Public Example

`copilotz-starter/web/components/ChatClient.tsx` and
`web/components/ProfileSidebar.tsx` show the recommended split:

- chat UI over thread and message endpoints
- profile UI over participant-backed data
- thin service modules under `web/services/`

## Validation Checklist

- the frontend calls app endpoints, not internal runtime APIs
- participant-backed UI state is normalized from the response transport
- durable profile state is not stored only in browser-local UI state
- thread-local UI logic is scoped to the active thread

## Related Pages

- [Persist User Context with Participants](./persist-user-context-with-participants.md)
- [Build Backend Endpoints with Features](./build-backend-endpoints-with-features.md)
- [Serve Copilotz with Oxian](./serve-copilotz-with-oxian.md)
