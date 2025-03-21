export default async function middleware(req) {

    const models = this.models;

    let provider;

    switch (new URL(req?.data?.url)?.pathname) {
        case '/ai/chat/openai':
            provider = 'openai';
            break;
        case '/ai/chat/gemini':
            provider = 'gemini';
            break;
        case '/ai/chat/claude':
            provider = 'claude';
            break;
        case '/ai/chat/groq':
            provider = 'groq';
            break;
        case '/ai/chat/deepseek':
            provider = 'deepseek';
            break;
    }

    if (!provider) {
        throw new Error('Provider not found');
    }

    if (!['openai', 'gemini'].includes(provider)) {
        throw new Error('Provider not supported');
    }

    const config = (await models.configs.findOne({ name: `${provider}_CREDENTIALS` })) || {};

    req.data.config = { ...req?.data?.config, ...config };

    return req
}