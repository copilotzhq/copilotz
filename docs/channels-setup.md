# Channels Setup

Copilotz supports several built-in channels for ingress and egress. This guide explains how to set up and configure each one.

## Web (SSE)

The Web channel is the default for browser-based chat. It uses Server-Sent Events (SSE) for real-time streaming.

### Configuration
No special configuration is required for the Web channel itself, but it is typically used with `copilotz.app.handle`.

### Usage
```typescript
// Ingress
const response = await app.handle({
  resource: "channels",
  method: "POST",
  path: ["web"],
  body: {
    content: "Hello",
    sender: { type: "user", externalId: "user_123" }
  }
});
```

---

## WhatsApp Cloud API

Integrate with WhatsApp using the Meta for Developers platform.

### Requirements
- A Meta Developer App
- WhatsApp product added to the app
- A Phone Number ID and WhatsApp Business Account ID

### Configuration
Set these environment variables or pass them in the context:
- `WHATSAPP_PHONE_NUMBER_ID`: The ID of your sending phone number.
- `WHATSAPP_ACCESS_TOKEN`: A permanent system user access token.
- `WHATSAPP_WEBHOOK_VERIFY_TOKEN`: A string of your choice to verify the webhook setup in Meta's dashboard.
- `WHATSAPP_APP_SECRET`: (Optional) Your Meta App Secret for signature verification.

### Webhook Setup
In the Meta Developer Portal:
1. Set the Webhook URL to `https://your-api.com/channels/whatsapp`.
2. Set the Verify Token to your `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.
3. Subscribe to `messages` under **WhatsApp Business Account**.

---

## Discord (Interactions)

Discord integration uses **Interactions (Webhooks)** instead of WebSockets, making it suitable for serverless environments.

### Requirements
- A Discord Application from the [Discord Developer Portal](https://discord.com/developers/applications).
- A Bot Token and Public Key.

### Configuration
- `DISCORD_APPLICATION_ID`: Found in the General Information tab.
- `DISCORD_PUBLIC_KEY`: Used to verify incoming interaction signatures.
- `DISCORD_BOT_TOKEN`: Found in the Bot tab.

### Webhook Setup
1. In the Discord Developer Portal, go to **General Information**.
2. Set **Interactions Endpoint URL** to `https://your-api.com/channels/discord`.
3. Discord will send a `PING` to verify the URL; Copilotz handles this automatically.

### Usage
Since this uses Interactions, users trigger the bot via Slash Commands (e.g., `/ask prompt:Hello`) or Message Components.

---

## Telegram (Bot API)

Telegram integration uses the official Bot API webhooks.

### Requirements
- A Bot created via [@BotFather](https://t.me/botfather).
- A Bot Token.

### Configuration
- `TELEGRAM_BOT_TOKEN`: The token provided by BotFather.
- `TELEGRAM_SECRET_TOKEN`: (Optional) A secret string for `X-Telegram-Bot-Api-Secret-Token` verification.

### Webhook Setup
You must manually tell Telegram where to send updates. You can do this with a simple curl command:
```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
     -H "Content-Type: application/json" \
     -d '{"url": "https://your-api.com/channels/telegram", "secret_token": "<YOUR_SECRET_TOKEN>"}'
```

---

## Zendesk Sunshine

Integrate Copilotz into your Zendesk support workflows.

### Configuration
- `ZENDESK_SUBDOMAIN`: Your Zendesk subdomain (e.g., `acme`).
- `ZENDESK_EMAIL`: The email of an admin or agent.
- `ZENDESK_API_TOKEN`: An API token generated in Zendesk Admin Center.
- `ZENDESK_WEBHOOK_SECRET`: Used to verify signatures from Zendesk.

---

## Mixing Channels

Copilotz allows you to receive a message on one channel and respond on another. This is configured via the path in `app.handle`:

```typescript
// Receive on WhatsApp, Respond on Zendesk
await app.handle({
  resource: "channels",
  method: "POST",
  path: ["whatsapp", "to", "zendesk"],
  body: whatsappPayload
});
```
