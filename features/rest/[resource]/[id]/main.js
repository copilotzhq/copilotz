async function GET ({ resource, id, _populate }) {
    id = Number(id);
    const { models } = this;
    if (!id) throw { message: 'Missing required fields: id' };
    if (!models?.[resource]) throw { message: 'Resource not found', status: 404 };
    return await models?.[resource]?.findOne({ _id: id }, { populate: _populate?.split(',') });
}

async function PUT ({ resource, id, ...data }) {
    id = Number(id);
    const { models } = this;
    if (!id) throw { message: 'Missing required fields: id' };
    if (!models?.[resource]) throw { message: 'Resource not found', status: 404 };
    return await models?.[resource]?.update({ _id: id }, { ...data });
}

async function DELETE ({ resource, id }) {
    id = Number(id);
    const { models } = this;
    if (!id) throw { message: 'Missing required fields: id' };
    if (!models?.[resource]) throw { message: 'Resource not found', status: 404 };
    await models?.[resource]?.delete({ _id: id });
    return { _id: id, deleted: true }
}


export {
    GET,
    PUT,
    DELETE
}