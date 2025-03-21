// Define the API key and endpoint
import formatChat, { tokenCounter } from '../helpers.js';

export default async function geminiChat(chat, stream = () => { }) {
    const env = this.env;
    const config = { ...this.config, ...chat?.config }

    if (typeof stream !== 'function') {
        stream = () => { }
    }

    const systemPrompts = [];
    const messages = formatChat({ ...chat, config });

    if (chat.answer) {
        return {
            prompt: messages,
            answer: typeof chat.answer === "string" ? chat.answer : JSON.stringify(chat.answer),
            tokens: 0
        }
    }
    

    const formattedMessages = messages
        .map(m => {
            if (m.role === 'system') {
                systemPrompts.push(m.content);
                return null;
            }
            return {
                parts: [{ text: m.content }],
                role: m.role === 'user' ? 'user' : 'model'
            }
        })
        .filter(Boolean)

    const systemPrompt = {
        parts: [{ text: systemPrompts?.join('\n') }]
    }

    const safetySettings = [
        {
            "category": "HARM_CATEGORY_HARASSMENT",
            "threshold": "BLOCK_NONE",
        },
        {
            "category": "HARM_CATEGORY_HATE_SPEECH",
            "threshold": "BLOCK_NONE",
        },
        {
            "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT",
            "threshold": "BLOCK_NONE",
        },
        {
            "category": "HARM_CATEGORY_DANGEROUS_CONTENT",
            "threshold": "BLOCK_NONE",
        },
    ]

    const API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/' +
        `${config.model || 'gemini-2.0-flash-lite-preview-02-05'}` +
        `:${config?.stream !== false ? ('stream' + 'G') : 'g'}enerateContent` +
        `?key=${config.apiKey}` +
        `${config?.stream !== false ? '&alt=sse' : ''}`;

    // Fetch the response from the Gemini API
    const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            contents: formattedMessages,
            generationConfig: {
                ...(
                    config.responseType === 'json'
                        ? { response_mime_type: 'application/json' }
                        : {}
                )
            },
            safetySettings,
            systemInstruction: systemPrompt
        })
    });

    if (!response.ok) {
        throw new Error(await response.text());
    }

    // create a reader to read the stream
    const reader = response?.body?.getReader();

    let resolver;

    const resolved = new Promise((resolve, reject) => {
        resolver = { resolve, reject };
    });
    let text = "";

    reader?.read()?.then(function processText({ done, value }) {
        // value for fetch streams is a Uint8Array
        const chunk = new TextDecoder("utf-8").decode(value);
        // split the chunk into lines
        chunk.split("\n").forEach((line) => {
            if (line.startsWith("data:")) {
                let data;
                try {
                    // parse the json
                    data = JSON.parse(line.slice(5).trim());
                } catch (e) {
                    "";
                }
                // get the delta from the json
                const delta = data?.candidates?.[0]?.content?.parts?.[0]?.text;
                // if there's a delta, then stream it
                if (delta) {
                    stream(delta);
                    text = text + delta;
                }
            }
        });

        // if it's done, then stop reading
        if (done) {
            resolver.resolve({ prompt: messages, answer: text, tokens: tokenCounter(messages, text) });
            return;
        }

        // Read some more, and call this function again
        return reader.read().then(processText);
    });
    return await resolved;
}

