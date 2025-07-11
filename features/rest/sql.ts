async function POST(this: any, { sql }) {
    const { models } = this;
    const model = Object.keys(models)[0];
    if (!model) throw { message: 'Resource not found', status: 404 };
    return await models?.[model]?.customQuery(sql);
};

export {
    POST
}
