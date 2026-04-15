---
name: configure-chat-ui
description: Frontend stack conventions, component patterns, and chat UI configuration for Copilotz web projects.
allowed-tools: [read_file, write_file, search_files]
tags: [framework, ui, config, frontend]
---

# Configure Chat UI

This skill covers two areas: the frontend stack conventions for Copilotz web projects, and the `ChatConfig` object used to customize the chat interface.

---

## Frontend Stack

Copilotz web UIs follow a consistent stack. All conventions below are established by the `copilotz-starter` template.

### Core Technologies

| Layer | Technology | Version |
|-------|-----------|---------|
| Framework | React | 19+ |
| Build | Vite | 6+ |
| CSS | Tailwind CSS v4 | 4+ (via `@tailwindcss/vite` plugin) |
| Components | shadcn/ui pattern | manual `components/ui/` dir |
| Icons | lucide-react | latest |
| Chat UI | `@copilotz/chat-ui` | latest |
| Chat adapter | `@copilotz/chat-adapter` | latest |

### Project Layout

```
web/
├── index.html              # SPA entry point
├── index.tsx               # React root mount
├── index.css               # Tailwind + chat-ui styles
├── App.tsx                 # Top-level routing (login / chat)
├── vite.config.ts          # Vite config (aliases, proxy, plugins)
├── lib/
│   └── utils.ts            # cn() helper (clsx + tailwind-merge)
├── components/
│   ├── ChatClient.tsx       # Main chat integration component
│   ├── ProfileSidebar.tsx   # Custom sidebar example
│   └── ui/                  # shadcn/ui primitives
│       ├── button.tsx
│       ├── badge.tsx
│       ├── card.tsx
│       ├── input.tsx
│       ├── textarea.tsx
│       ├── separator.tsx
│       └── scroll-area.tsx
├── services/
│   ├── api.ts               # API base URL + auth headers
│   ├── agentsService.ts     # Fetch agents list
│   └── participantsService.ts  # User profile CRUD
└── package.json
```

### Styling Conventions

**CSS entry point** — `index.css` imports Tailwind and chat-ui styles:

```css
@import "tailwindcss";
@import "@copilotz/chat-ui/styles.css";
```

**Tailwind v4** — uses `@tailwindcss/vite` plugin directly (no `tailwind.config.js`). Configuration is done via CSS `@theme` directives when needed.

**Class composition** — use the `cn()` utility from `lib/utils.ts` (combines `clsx` + `tailwind-merge`) for conditional and merged class names:

```tsx
import { cn } from "@/lib/utils.ts";

<div className={cn("rounded-lg border p-3", isActive && "border-primary")} />
```

### shadcn/ui Pattern

Components live in `components/ui/` and follow the shadcn convention:

- Each file exports a single primitive component
- Uses `class-variance-authority` (`cva`) for variant definitions
- Uses Radix UI primitives for accessible behavior (`@radix-ui/react-*`)
- Uses `cn()` for class merging
- Components accept standard HTML props plus variant props

To add a new shadcn component, create it in `components/ui/` following the same pattern. Do not install shadcn CLI — components are copied manually.

### Vite Configuration

```typescript
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, ".") },
  },
  plugins: [tailwindcss()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
});
```

Key points:
- `@` alias points to the `web/` root
- API calls proxy to the Deno backend at `localhost:8000` during development
- React deduplication is configured to prevent multiple React instances when linking local packages

### API Integration

The `services/api.ts` module provides:
- `API_BASE` — resolved from `import.meta.env.VITE_API_URL`, defaults to `"/api"` (proxied by Vite in dev)
- `apiUrl(path)` — builds full API URL
- `withAuthHeaders(headers)` — injects `Authorization: Bearer <key>` from `VITE_API_KEY` env var

Service files (`agentsService.ts`, `participantsService.ts`) use plain `fetch` with these helpers. There is no global HTTP client or state management library.

### Custom Sidebar Component Pattern

The starter template includes a `ProfileSidebar` that demonstrates the full pattern for building a custom panel that renders beside the chat. This is the recommended approach for any custom sidebar (settings, knowledge base, user profile, etc.).

**Wiring it up in `ChatClient.tsx`:**

```tsx
import { CopilotzChat } from "@copilotz/chat-adapter";
import { PanelRightOpen } from "lucide-react";
import { ProfileSidebar } from "./ProfileSidebar.tsx";

const config: ChatConfig = {
  customComponent: {
    label: "Profile",
    icon: <PanelRightOpen className="h-5 w-5" />,
  },
};

export const ChatClient: React.FC<{ userId: string }> = ({ userId }) => {
  const renderSidebar = useCallback(
    ({ onClose, isMobile }: { onClose: () => void; isMobile: boolean }) => (
      <ProfileSidebar userId={userId} onClose={onClose} isMobile={isMobile} />
    ),
    [userId],
  );

  return (
    <CopilotzChat
      userId={userId}
      config={config}
      customComponent={renderSidebar}
    />
  );
};
```

**Building the sidebar component:**

The sidebar receives `{ onClose, isMobile }` from the chat adapter. Follow these conventions:

- Wrap in `<aside className="flex h-full flex-col bg-background">`
- Include a header with a title and close/refresh buttons (show close button only when `isMobile`)
- Use `<ScrollArea>` for the scrollable content area
- Organize content into `<Card>` sections with `<CardHeader>` and `<CardContent>`
- Use shadcn primitives (`Button`, `Input`, `Textarea`, `Badge`, `Separator`) for form controls
- Keep API calls in `services/` and call them from the sidebar via `useCallback` handlers
- Use `useState` for local draft state and `useEffect` to load data on mount

**Reacting to chat events in the sidebar:**

To refresh sidebar data when a tool call mutates backend state, use `onToolOutput` on the chat component:

```tsx
const [refreshToken, setRefreshToken] = useState(0);

const handleToolOutput = useCallback((output: Record<string, unknown>) => {
  if (isMutationOutput(output)) {
    setRefreshToken((n) => n + 1);
  }
}, []);

<CopilotzChat onToolOutput={handleToolOutput} ... />

// In sidebar, re-fetch when refreshToken changes:
useEffect(() => { void loadData(); }, [loadData, refreshToken]);
```

### Adding New Pages / Components

1. Create component in `components/`
2. Use shadcn primitives from `components/ui/` for consistent styling
3. Use `lucide-react` for icons
4. Use `cn()` for class composition
5. For API calls, add a service file under `services/` using `apiUrl()` and `withAuthHeaders()`
6. Import types from shared schemas under `resources/schemas/` when available

---

## Chat Configuration

Customize the Copilotz chat interface via the `ChatConfig` object passed to `CopilotzChat` or `ChatUI`.

### Configuration Structure

```tsx
<CopilotzChat
  userId="user-123"
  config={{
    branding: { ... },
    features: { ... },
    ui: { ... },
    labels: { ... },
    voiceCompose: { ... },
    agentSelector: { ... },
    markdown: { ... },
    customComponent: { ... },
    headerActions: ReactNode,
  }}
/>
```

### Branding

```typescript
branding: {
  logo: ReactNode | null,      // Header logo
  avatar: string | null,       // Assistant avatar URL
  title: 'My Assistant',       // Header title
  subtitle: 'How can I help?', // Header subtitle
}
```

### Features

Toggle UI capabilities on/off:

```typescript
features: {
  enableThreads: true,           // Thread sidebar and management
  enableFileUpload: true,        // File attachment button
  enableAudioRecording: true,    // Audio recording button
  enableMessageEditing: true,    // Edit sent messages
  enableMessageCopy: true,       // Copy message content
  enableRegeneration: true,      // Regenerate last response
  enableToolCallsDisplay: true,  // Show tool call details
  maxAttachments: 4,             // Max files per message
  maxFileSize: 10 * 1024 * 1024, // Max file size (10MB)
}
```

### UI Settings

```typescript
ui: {
  theme: 'auto',                  // 'light', 'dark', or 'auto'
  showTimestamps: false,
  showAvatars: true,
  compactMode: false,
  showWordCount: false,
  renderUserMarkdown: true,       // Render markdown in user messages
  collapseLongMessages: false,    // Collapse long AI responses
  longMessagePreviewChars: 4000,  // Chars shown before "Show more"
}
```

### Agent Selector

For multi-agent setups, enable the agent picker:

```typescript
agentSelector: {
  enabled: true,
  label: 'Select agent',
  hideIfSingle: true,  // Hide selector when only one agent
}
```

Then pass agent data to the component:

```tsx
<CopilotzChat
  userId="user-123"
  agentOptions={[
    { id: 'support', name: 'Support', description: 'Customer help' },
    { id: 'dev', name: 'Developer', description: 'Code assistant' },
  ]}
  selectedAgentId={selectedAgent}
  onSelectAgent={setSelectedAgent}
  config={{ agentSelector: { enabled: true } }}
/>
```

### Voice Compose

Enable voice input with a voice provider package:

```bash
npm install @copilotz/chat-voice-moonshine
# or
npm install @copilotz/chat-voice-vad
```

```tsx
import { createMoonshineVoiceProvider } from '@copilotz/chat-voice-moonshine';

<CopilotzChat
  userId="user-123"
  config={{
    voiceCompose: {
      enabled: true,
      defaultMode: 'text',         // 'text' or 'voice' initial mode
      reviewMode: 'manual',        // 'manual' or 'auto-send'
      autoSendDelayMs: 5000,       // Delay before auto-send (if auto-send mode)
      showTranscriptPreview: true,
      transcriptMode: 'final-only', // 'live', 'final-only', or 'none'
      createProvider: createMoonshineVoiceProvider(),
    },
  }}
/>
```

### Voice Provider Options

**Moonshine** (client-side STT):
```typescript
createMoonshineVoiceProvider({
  modelUrl: undefined,        // Custom model URL
  precision: undefined,       // Model precision
  verboseLogging: false,
})
```

**VAD** (Voice Activity Detection):
```typescript
import { createVadVoiceProvider } from '@copilotz/chat-voice-vad';

createVadVoiceProvider({
  model: 'v5',               // 'legacy' or 'v5'
  sampleRate: 16000,
  submitUserSpeechOnPause: true,
})
```

### Custom Sidebar Component

Add a custom right-panel (e.g., user profile, settings). The `customComponent` prop accepts three signatures:

1. **A React node** — static content
2. **A function receiving `ChatUserContext`** — access to user context
3. **A function receiving `{ onClose, isMobile }`** — layout-aware (recommended)

```tsx
// Recommended: layout-aware signature
<CopilotzChat
  userId="user-123"
  customComponent={({ onClose, isMobile }) => (
    <MySidebar onClose={onClose} isMobile={isMobile} />
  )}
  config={{
    customComponent: {
      label: "Profile",        // Tooltip text
      icon: <UserIcon />,      // Toggle button icon in header
    },
  }}
/>
```

See the "Custom Sidebar Component Pattern" section under Frontend Stack above for full implementation conventions and the `onToolOutput` refresh pattern.

### Custom Header Actions

Add buttons to the chat header:

```tsx
<CopilotzChat
  userId="user-123"
  config={{
    headerActions: (
      <>
        <button onClick={exportChat}>Export</button>
        <button onClick={openSettings}>Settings</button>
      </>
    ),
  }}
/>
```

### Labels

Override any UI text string via `labels`. All keys default to English. Common overrides:

```typescript
labels: {
  inputPlaceholder: 'Ask me anything...',
  sendButton: 'Send',
  newThread: 'New Chat',
  thinking: 'Processing...',
  footerLabel: 'AI can make mistakes.',
  defaultThreadName: 'Chat',
}
```

### Theming

The UI uses CSS custom properties and supports Tailwind's `dark` class. Set `ui.theme` to `'light'`, `'dark'`, or `'auto'` (follows system preference). Override colors via CSS variables using shadcn conventions:

```css
:root {
  --background: 0 0% 100%;
  --foreground: 222.2 84% 4.9%;
  --primary: 222.2 47.4% 11.2%;
  --primary-foreground: 210 40% 98%;
}
```

### Notes

- Config is deep-merged with defaults; you only need to specify overrides
- The `customComponent` prop on `CopilotzChat` accepts a React node, a function receiving `ChatUserContext`, or a function receiving `{ onClose, isMobile }`
