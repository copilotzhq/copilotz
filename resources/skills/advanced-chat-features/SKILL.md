---
name: advanced-chat-features
description: Implement advanced chat adapter features like event interceptors, special states, bootstrap flows, custom sidebar components, and dynamic auth.
allowed-tools: [read_file, write_file, search_files]
tags: [framework, ui, adapter]
---

# Advanced Chat Features

Advanced integration patterns for `@copilotz/chat-adapter` beyond basic setup.

## Event Interceptors

Intercept SSE events from the Copilotz API before they reach the UI. Use this for custom event handling, analytics, or triggering special states.

```tsx
import { CopilotzChat } from '@copilotz/chat-adapter';
import type { EventInterceptor } from '@copilotz/chat-adapter';

const interceptor: EventInterceptor = (event) => {
  const { type, payload } = event as { type: string; payload: any };

  if (type === 'MESSAGE' && payload?.metadata?.requiresAction) {
    return {
      handled: true,  // prevents default processing
      specialState: {
        kind: 'action-required',
        title: 'Action Required',
        message: payload.metadata.actionMessage,
        payload: payload.metadata,
      },
    };
  }

  // Return void to let the event process normally
};

<CopilotzChat
  userId="user-123"
  eventInterceptor={interceptor}
  renderSpecialState={...}
/>
```

Events the interceptor receives: `TOKEN`, `MESSAGE`, `NEW_MESSAGE`, `TOOL_CALL`, `ASSET_CREATED`, `ERROR`.

If `handled: true` is returned, the event is consumed and not rendered in the chat.

## Special States

Special states replace the entire chat UI with custom content. They're triggered by event interceptors or error interceptors.

```tsx
import type { RenderSpecialState, SpecialChatState } from '@copilotz/chat-adapter';

const renderSpecialState: RenderSpecialState = (state, controls) => {
  switch (state.kind) {
    case 'auth-required':
      return <LoginScreen onLogin={() => controls.clear()} />;

    case 'action-required':
      return (
        <div>
          <h2>{state.title}</h2>
          <p>{state.message}</p>
          <button onClick={() => {
            handleAction(state.payload);
            controls.clear();  // returns to the chat
          }}>
            Confirm
          </button>
        </div>
      );

    default:
      return null;  // fall through to normal chat
  }
};

<CopilotzChat
  userId="user-123"
  eventInterceptor={interceptor}
  renderSpecialState={renderSpecialState}
/>
```

`SpecialChatState` shape:

```typescript
{
  kind: string;        // discriminator for your switch
  title?: string;
  message?: string;
  payload?: Record<string, unknown>;  // arbitrary data
}
```

## Error Interceptors

Handle streaming errors and optionally display a special state instead of the default error message.

```tsx
import type { RunErrorInterceptor } from '@copilotz/chat-adapter';

const errorInterceptor: RunErrorInterceptor = (error) => {
  if (error instanceof Response && error.status === 401) {
    return {
      kind: 'auth-required',
      title: 'Session Expired',
      message: 'Please log in again.',
    };
  }
  return null;  // use default error handling
};

<CopilotzChat
  userId="user-123"
  runErrorInterceptor={errorInterceptor}
  renderSpecialState={renderSpecialState}
/>
```

## Bootstrap

Auto-run an initial message or tool calls when a new conversation starts (no existing threads).

```tsx
<CopilotzChat
  userId="user-123"
  bootstrap={{
    initialMessage: 'Hello! Set up my workspace.',
    initialToolCalls: [
      { name: 'load_user_preferences', args: { userId: 'user-123' } },
    ],
  }}
/>
```

Bootstrap only fires when the user has no existing threads. The message and/or tool calls are sent automatically, and the streaming response appears as the first conversation.

## Custom Sidebar Component

Add a right-panel component toggled from the header. Receives either a `ChatUserContext` or panel control props.

```tsx
// Option 1: Function receiving user context
<CopilotzChat
  userId="user-123"
  customComponent={(context: ChatUserContext) => (
    <ProfilePanel user={context} />
  )}
  config={{
    customComponent: {
      icon: <UserIcon className="h-5 w-5" />,
    },
  }}
/>

// Option 2: Function receiving panel controls
<CopilotzChat
  userId="user-123"
  customComponent={({ onClose, isMobile }) => (
    <SettingsPanel onClose={onClose} fullWidth={isMobile} />
  )}
  config={{
    customComponent: {
      icon: <SettingsIcon className="h-5 w-5" />,
    },
  }}
/>

// Option 3: Static React node
<CopilotzChat
  userId="user-123"
  customComponent={<HelpPanel />}
/>
```

The `ChatUserContext` is populated from tool outputs that return a `userContext` field in their metadata, and from thread metadata. It persists across the session and is useful for profile-aware sidebars.

## Tool Output Callbacks

React to tool execution results in real-time during streaming.

```tsx
<CopilotzChat
  userId="user-123"
  onToolOutput={(output) => {
    if (output.userContext) {
      updateLocalProfile(output.userContext);
    }
    if (output.navigateTo) {
      router.push(output.navigateTo as string);
    }
  }}
/>
```

Tool outputs with a `userContext` field are automatically merged into the `ChatUserContext`, which is then available to custom components and persisted in thread metadata.

## Dynamic Auth Headers

For apps with token-based auth (JWT, OAuth), provide headers dynamically instead of using environment variables.

```tsx
<CopilotzChat
  userId={user.id}
  getRequestHeaders={async () => {
    const token = await refreshTokenIfNeeded();
    return {
      Authorization: `Bearer ${token}`,
      'X-Tenant-Id': tenant.id,
    };
  }}
/>
```

This overrides the default `VITE_API_KEY` / `VITE_COPILOTZ_API_KEY` env var auth. The function is called before every API request (streaming runs, thread fetches, asset resolution).

## User Lifecycle Callbacks

```tsx
<CopilotzChat
  userId={user.id}
  onLogout={() => {
    auth.signOut();
    router.push('/login');
  }}
  onViewProfile={() => router.push('/profile')}
  onAddMemory={(content, category) => {
    // User explicitly asked the AI to remember something
    console.log(`Memory added: [${category}] ${content}`);
  }}
  onUpdateMemory={(memoryId, content) => { ... }}
  onDeleteMemory={(memoryId) => { ... }}
/>
```

## URL State Sync

Thread IDs are automatically synced to the URL query string (`?thread=...`). This enables deep-linking to specific conversations and preserves thread state across page reloads.

The `useUrlState` hook handles this internally. No configuration needed -- it works by default when `CopilotzChat` or `useCopilotz` is used.

## Notes

- Event and error interceptors run synchronously; avoid heavy computation
- Special states fully replace the `ChatUI` render -- call `controls.clear()` to return to the chat
- Bootstrap only triggers when the user has zero threads; it does not re-run on subsequent visits
- The adapter communicates via `POST /v1/providers/web` (SSE streaming) and REST endpoints for threads and assets
- Audio attachments (WebM, OGG) are automatically converted to WAV before sending
