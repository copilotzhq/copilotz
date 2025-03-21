import formatChat, { tokenCounter } from '../helpers.js';

async function openAiChat(chat, stream = () => { }) {

  if (typeof stream !== 'function') {
    stream = stream.stream
  }

  const env = this.env
  const config = { ...this.config, ...chat?.config }

  const messages = formatChat({ ...chat, config });

  if (chat.answer) {
    return {
      prompt: messages,
      answer: typeof chat.answer === "string" ? chat.answer : JSON.stringify(chat.answer),
      tokens: 0
    }
  }

  // call the openai api
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey || env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      messages,
      model: config.model || "gpt-4o-mini",
      stream: true,
      temperature: config.temperature || 0,
      max_completion_tokens: config.maxCompletionTokens || 1000,
      response_format: config.responseType === "json"
        ? { type: "json_object" }
        : undefined,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("API response error:", errorText);
    throw new Error(errorText);
  }

  // create a reader to read the stream
  const reader = response.body?.getReader();
  const decoder = new TextDecoder("utf-8");

  let text = "";
  let resolver;
  let bufferedData = "";

  const resolved = new Promise((resolve, reject) => {
    resolver = { resolve, reject };
  });

  async function processText({ done, value }) {

    if (done) {

      // Process any remaining buffered data
      if (bufferedData) {
        try {
          const lines = bufferedData.split("\n");
          lines.forEach((line) => {
            if (line.startsWith("data:")) {
              const data = JSON.parse(line.slice(5).trim());

              const delta = data?.choices?.[0]?.delta?.content;
              if (delta) {
                stream(delta);
                text += delta;
              }
            }
          });
        } catch (e) {
          console.error("Failed to parse remaining buffered data:", e, "Buffered data:", bufferedData);
        }
      }

      resolver.resolve({ prompt: messages, answer: text, tokens: tokenCounter(messages, text) });
      return;
    }

    const chunk = decoder.decode(value, { stream: true });

    bufferedData += chunk;
    const lines = bufferedData.split("\n");

    // Keep the last incomplete line in the buffer
    bufferedData = lines.pop();

    lines.forEach((line) => {
      if (line.startsWith("data:")) {
        let data;
        try {
          data = JSON.parse(line.slice(5).trim());
        } catch (e) {
          !line?.slice(5)?.trim()?.startsWith('[DONE]') &&
            console.error("Failed to parse JSON:", e, "Line:", line);
          return;
        }

        const delta = data?.choices?.[0]?.delta?.content;
        if (delta) {
          stream(delta);
          text += delta;
        }
      }
    });

    return reader.read().then(processText).catch((error) => {
      console.error("Error reading stream:", error);
      resolver.reject(error);
    });
  }

  reader.read().then(processText).catch((error) => {
    console.error("Error starting stream read:", error);
    resolver.reject(error);
  });

  return await resolved;
};


export default openAiChat;