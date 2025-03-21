export default async function middleware(req) {

    const models = this.models;

    const pathname = new URL(req?.url)?.pathname;
    const providerArr = pathname.split('/').filter(Boolean);
    const provider = providerArr[providerArr.length - 1];

    if (!provider) {
        throw new Error('Provider not found');
    }

    if (!['openai', 'gemini'].includes(provider)) {
        throw new Error('Provider not supported');
    }

    const { value: config } = (await models.configs.findOne({ name: `${provider}_CREDENTIALS` })) || {};


    req.params.config = { ...req?.params?.config, ...config };

    return req
}