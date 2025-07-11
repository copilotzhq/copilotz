
async function GET ({ resource, _populate, ...queryParams }) {
    const { models } = this;
    if (!models?.[resource]) throw { message: 'Resource not found', status: 404 };
    return {
        data: (await models?.[resource]?.find(queryParams, { populate: _populate?.split(',') })) || []
    }
};

async function POST ({ resource, ...data }) {
    const { models } = this;
    if (!models?.[resource]) throw { message: 'Resource not found', status: 404 };
    return await models?.[resource]?.create(data);
};

export {
    GET,
    POST
}