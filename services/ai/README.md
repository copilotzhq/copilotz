# 🤖 Unified AI Service

A single, strongly-typed TypeScript API for all AI capabilities including LLM chat, embeddings, speech-to-text, text-to-speech, and image generation with **15+ providers**.

## ✨ Features

- **🎯 Single Entrypoint**: One `ai()` function for all AI services
- **🔒 Type Safety**: Full TypeScript support with discriminated unions
- **🔄 Multiple Providers**: 15+ providers across all AI service types
- **📦 Convenience Functions**: Optional explicit functions for better DX
- **🔄 Backward Compatible**: Existing LLM service still works
- **⚡ Performance**: Optimized routing and error handling

## 🌐 Supported Providers

### 💬 LLM Chat (7 providers)
- **OpenAI** - GPT-4, GPT-4o, GPT-4o-mini, GPT-4-turbo
- **Anthropic** - Claude 3.5 Sonnet, Claude 3 Haiku, Claude 3 Opus
- **Google** - Gemini 1.5 Pro, Gemini 1.5 Flash, Gemini 2.0 Flash
- **Groq** - Llama 3.1, Mixtral, Gemma 2 (ultra-fast inference)
- **DeepSeek** - DeepSeek Chat, DeepSeek Coder
- **Ollama** - Local models (Llama, Mistral, CodeLlama)
- **xAI** - Grok models

### 📊 Embeddings (3 providers)
- **OpenAI** - text-embedding-3-small, text-embedding-3-large, text-embedding-ada-002
- **Cohere** - embed-english-v3.0, embed-multilingual-v3.0
- **HuggingFace** - Sentence Transformers, custom models

### 🎙️ Speech-to-Text (3 providers)
- **OpenAI** - Whisper-1 (multilingual, high accuracy)
- **AssemblyAI** - Advanced transcription with speaker diarization
- **Deepgram** - Real-time transcription, Nova-2 model

### 🔊 Text-to-Speech (3 providers)
- **OpenAI** - Alloy, Echo, Fable, Onyx, Nova, Shimmer voices
- **ElevenLabs** - High-quality voice synthesis, custom voices
- **Azure** - Neural voices, enterprise-grade TTS

### 🎨 Image Generation (3 providers)
- **OpenAI** - DALL-E 3, DALL-E 2 (integrated with ChatGPT)
- **Stability AI** - Stable Diffusion XL, custom models
- **Replicate** - SDXL, Kandinsky, Midjourney-style models

## 🚀 Quick Start

```typescript
import { ai, chat, embed, transcribe, speak, generateImage } from './services/ai/index.ts';

// LLM Chat with different providers
const openaiResponse = await ai({
  type: 'llm',
  messages: [{ role: 'user', content: 'Hello from OpenAI!' }],
  config: { provider: 'openai', model: 'gpt-4o-mini' }
});

const claudeResponse = await ai({
  type: 'llm', 
  messages: [{ role: 'user', content: 'Hello from Claude!' }],
  config: { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' }
});

// Embeddings with different providers
const openaiEmbeddings = await ai({
  type: 'embedding',
  input: 'Text to embed with OpenAI',
  config: { provider: 'openai', model: 'text-embedding-3-small' }
});

const cohereEmbeddings = await ai({
  type: 'embedding',
  input: 'Text to embed with Cohere',
  config: { provider: 'cohere', model: 'embed-english-v3.0' }
});

// Speech-to-Text with different providers
const whisperTranscription = await ai({
  type: 'speech-to-text',
  audio: audioBlob,
  config: { provider: 'openai', language: 'en' }
});

const assemblyTranscription = await ai({
  type: 'speech-to-text',
  audio: audioBlob,
  config: { provider: 'assemblyai', language: 'en_us' }
});

// Text-to-Speech with different providers
const openaiSpeech = await ai({
  type: 'text-to-speech',
  text: 'Hello from OpenAI TTS!',
  config: { provider: 'openai', voice: 'alloy' }
});

const elevenlabsSpeech = await ai({
  type: 'text-to-speech',
  text: 'Hello from ElevenLabs!',
  config: { provider: 'elevenlabs', voice: 'alloy' }
});

// Image Generation with different providers
const dalleImage = await ai({
  type: 'image-generation',
  prompt: 'A beautiful sunset over mountains',
  config: { provider: 'openai', size: '1024x1024', quality: 'hd' }
});

const stableDiffusionImage = await ai({
  type: 'image-generation',
  prompt: 'A beautiful sunset over mountains',
  config: { provider: 'stability', size: '1024x1024', style: 'photographic' }
});
```

## 🎯 Convenience Functions

For better developer experience, use explicit functions:

```typescript
// LLM Chat
const response = await chat({
  messages: [{ role: 'user', content: 'Hello!' }],
  config: { provider: 'anthropic' } // Defaults to Claude
});

// Embeddings  
const embeddings = await embed({
  input: 'Text to embed',
  config: { provider: 'cohere' } // High-quality embeddings
});

// Speech-to-Text
const transcription = await transcribe({
  audio: audioBlob,
  config: { provider: 'deepgram' } // Real-time transcription
});

// Text-to-Speech
const speech = await speak({
  text: 'Hello, world!',
  config: { provider: 'elevenlabs', voice: 'nova' } // High-quality voices
});

// Image Generation
const image = await generateImage({
  prompt: 'A beautiful sunset',
  config: { provider: 'stability' } // Stable Diffusion
});
```

## 🔧 Provider-Specific Configuration

### LLM Providers

```typescript
// OpenAI (GPT models)
const openaiConfig = {
  provider: 'openai',
  model: 'gpt-4o',
  temperature: 0.7,
  maxTokens: 1000,
  reasoningEffort: 'medium' // For o3 models
};

// Anthropic (Claude models)
const anthropicConfig = {
  provider: 'anthropic',
  model: 'claude-3-5-sonnet-20241022',
  temperature: 0.7,
  maxTokens: 1000
};

// Groq (Ultra-fast inference)
const groqConfig = {
  provider: 'groq',
  model: 'llama-3.1-70b-versatile',
  temperature: 0.7,
  maxTokens: 1000
};
```

### Embedding Providers

```typescript
// OpenAI Embeddings
const openaiEmbedConfig = {
  provider: 'openai',
  model: 'text-embedding-3-large',
  dimensions: 1536
};

// Cohere Embeddings
const cohereEmbedConfig = {
  provider: 'cohere',
  model: 'embed-english-v3.0'
};

// HuggingFace Embeddings  
const hfEmbedConfig = {
  provider: 'huggingface',
  model: 'sentence-transformers/all-MiniLM-L6-v2'
};
```

### Speech-to-Text Providers

```typescript
// OpenAI Whisper
const whisperConfig = {
  provider: 'openai',
  model: 'whisper-1',
  language: 'en',
  responseFormat: 'verbose_json'
};

// AssemblyAI (Advanced features)
const assemblyConfig = {
  provider: 'assemblyai',
  language: 'en_us',
  prompt: 'Custom vocabulary words'
};

// Deepgram (Real-time)
const deepgramConfig = {
  provider: 'deepgram',
  model: 'nova-2',
  language: 'en-US'
};
```

### Text-to-Speech Providers

```typescript
// OpenAI TTS
const openaiTTSConfig = {
  provider: 'openai',
  voice: 'alloy',
  responseFormat: 'mp3',
  speed: 1.0
};

// ElevenLabs (High-quality)
const elevenlabsConfig = {
  provider: 'elevenlabs',
  voice: 'nova',
  model: 'eleven_monolingual_v1'
};

// Azure Speech
const azureConfig = {
  provider: 'azure',
  voice: 'en-US-JennyNeural',
  responseFormat: 'mp3',
  speed: 1.0
};
```

### Image Generation Providers

```typescript
// OpenAI DALL-E
const dalleConfig = {
  provider: 'openai',
  model: 'dall-e-3',
  size: '1024x1024',
  quality: 'hd',
  style: 'vivid'
};

// Stability AI
const stabilityConfig = {
  provider: 'stability',
  model: 'stable-diffusion-xl-1024-v1-0',
  size: '1024x1024'
};

// Replicate (Multiple models)
const replicateConfig = {
  provider: 'replicate',
  model: 'sdxl',
  size: '1024x1024'
};
```

## 🔑 Environment Variables

Set API keys for automatic detection:

```bash
# Primary keys (recommended)
DEFAULT_OPENAI_KEY=sk-...
DEFAULT_ANTHROPIC_KEY=sk-ant-...
DEFAULT_GEMINI_KEY=...
DEFAULT_GROQ_KEY=gsk_...
DEFAULT_DEEPSEEK_KEY=...
DEFAULT_COHERE_KEY=...
DEFAULT_HUGGINGFACE_KEY=hf_...
DEFAULT_ASSEMBLYAI_KEY=...
DEFAULT_DEEPGRAM_KEY=...
DEFAULT_ELEVENLABS_KEY=...
DEFAULT_AZURE_SPEECH_KEY=...
DEFAULT_STABILITY_KEY=sk-...
DEFAULT_REPLICATE_KEY=r8_...

# Azure specific
AZURE_SPEECH_REGION=eastus

# Fallback keys  
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
# ... (same pattern for all providers)
```

## 🧪 Testing

Run comprehensive tests for all providers:

```bash
# Set your API keys
export DEFAULT_OPENAI_KEY="sk-..."
export DEFAULT_ANTHROPIC_KEY="sk-ant-..."
export DEFAULT_COHERE_KEY="..."
export DEFAULT_ELEVENLABS_KEY="..."
# ... (set keys for providers you want to test)

# Run unified AI service tests
deno run --allow-net --allow-env services/ai/index.ts

# Run provider-specific tests
deno run --allow-net --allow-env services/ai/test-providers.ts
```

## 🎯 Advanced Usage

### Multi-Provider Workflows

```typescript
// Compare responses across LLM providers
const providers = ['openai', 'anthropic', 'gemini'];
const responses = await Promise.all(
  providers.map(provider => 
    chat({
      messages: [{ role: 'user', content: 'Explain quantum computing' }],
      config: { provider }
    })
  )
);

// Use best embedding provider for your use case
const embeddings = await embed({
  input: ['Technical documentation', 'User queries'],
  config: { 
    provider: 'cohere', // Best for semantic search
    model: 'embed-english-v3.0'
  }
});

// Chain services: Audio → Text → AI → Speech
const transcription = await transcribe({
  audio: audioFile,
  config: { provider: 'assemblyai' } // Best accuracy
});

const aiResponse = await chat({
  messages: [{ 
    role: 'user', 
    content: `Summarize: ${transcription.text}` 
  }],
  config: { provider: 'anthropic' } // Best reasoning
});

const speech = await speak({
  text: aiResponse.answer,
  config: { provider: 'elevenlabs' } // Best quality
});
```

### Provider Selection Logic

```typescript
// Smart provider selection based on requirements
function selectProvider(requirements: {
  speed?: 'fast' | 'balanced' | 'quality';
  cost?: 'low' | 'medium' | 'high';
  features?: string[];
}) {
  if (requirements.speed === 'fast') {
    return {
      llm: 'groq',
      embedding: 'openai',
      stt: 'deepgram',
      tts: 'openai',
      imageGen: 'openai'
    };
  }
  
  if (requirements.cost === 'low') {
    return {
      llm: 'deepseek',
      embedding: 'huggingface',
      stt: 'openai',
      tts: 'openai',
      imageGen: 'stability'
    };
  }
  
  // Default to quality providers
  return {
    llm: 'anthropic',
    embedding: 'cohere',  
    stt: 'assemblyai',
    tts: 'elevenlabs',
    imageGen: 'stability'
  };
}
```

## 🏗️ Architecture

```
services/ai/
├── index.ts                    # 🎯 Main unified entrypoint
├── types.ts                    # 🔒 Comprehensive type definitions
├── test-providers.ts           # 🧪 Provider test suite
├── llm/                        # 💬 LLM service (7 providers)
│   ├── providers/
│   │   ├── openai.ts
│   │   ├── anthropic.ts  
│   │   ├── gemini.ts
│   │   ├── groq.ts
│   │   ├── deepseek.ts
│   │   ├── ollama.ts
│   │   └── index.ts
│   └── ...
├── embedding/                  # 📊 Embedding service (3 providers)
│   └── providers/
│       ├── openai.ts
│       ├── cohere.ts
│       ├── huggingface.ts
│       └── index.ts
├── speech-to-text/            # 🎙️ STT service (3 providers)
│   └── providers/
│       ├── openai.ts
│       ├── assemblyai.ts
│       ├── deepgram.ts
│       └── index.ts
├── text-to-speech/            # 🔊 TTS service (3 providers)
│   └── providers/
│       ├── openai.ts
│       ├── elevenlabs.ts
│       ├── azure.ts
│       └── index.ts
└── image-gen/                 # 🎨 Image generation (3 providers)
    └── providers/
        ├── openai.ts
        ├── stability.ts
        ├── replicate.ts
        └── index.ts
```

## 🌟 Provider Highlights

### 🏆 Best for Performance
- **LLM**: Groq (ultra-fast inference)
- **Embedding**: OpenAI (optimized for speed)
- **STT**: Deepgram (real-time processing)
- **TTS**: OpenAI (low latency)
- **Image**: OpenAI (integrated generation)

### 🏆 Best for Quality  
- **LLM**: Anthropic Claude (reasoning)
- **Embedding**: Cohere (semantic understanding)
- **STT**: AssemblyAI (accuracy + features)
- **TTS**: ElevenLabs (voice quality)
- **Image**: Stability AI (customization)

### 🏆 Best for Cost
- **LLM**: DeepSeek (competitive pricing)
- **Embedding**: HuggingFace (open source)
- **STT**: OpenAI Whisper (good value)
- **TTS**: Azure (enterprise pricing)
- **Image**: Replicate (flexible pricing)

## 🚀 Ready to use with 15+ AI providers!

The unified AI service provides a single, consistent interface to the best AI providers available, with intelligent routing, comprehensive error handling, and full TypeScript support. 