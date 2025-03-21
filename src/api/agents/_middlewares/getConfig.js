async function getConfig(req) {

    const data = req?.data || {};
    const resources = data?.resources || {};

    const { models } = this;

    const { copilotz, config = {} } = resources;

    // Get the Copilotz's configuration
    let configsArr = (await models.configs.find({ owner: copilotz._id, type: 'copilotz' })) || [];

    // Join Copilotz's configuration with the config passed by params
    configsArr = [...(copilotz.configs || []), ...(configsArr || [])].filter(c => c?._id)

    // Remove duplicates
    configsArr = configsArr.filter(
        (c, index) => configsArr.findIndex((t) => t?._id === c?._id) === index
    );

    // Convert the configuration array to an object
    const _config = configsArr.reduce((obj, c) => {
        obj[c.name] = c.value;
        return obj;
    }, {});

    data.resources.config = { ...config, ..._config };
    req.data = data;

    return req;
}

export default getConfig;