async function getJob(req) {
    const { models } = this;

    const data = req?.data || {};
    const resources = data?.resources || {};
    const { copilotz } = resources;

    if (!copilotz?.job) return req;

    const job = await models.jobs.findOne({ _id: copilotz?.job }, { populate: ['actions'] });

    const workflowIds = job.workflows || [job.defaultWorkflow];

    const workflows = await Promise.all(workflowIds.map(async (workflow) => {
        return await models.workflows.findOne({ _id: workflow }, { populate: ['steps'] });
    }));

    job.workflows = workflows;

    resources.copilotz = {
        ...copilotz,
        job
    };

    data.resources = { ...resources, copilotz: { ...copilotz, job } };
    req.data = data;

    return req;
}

export default getJob;