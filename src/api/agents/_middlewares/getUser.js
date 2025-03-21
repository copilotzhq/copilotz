async function getUsers(req) {

    const { models } = this;

    if (!req.data?.user?.phone && !req.data?.user?.email) return req;

    const data = req?.data || {};

    let usersPhonePromise, usersEmailPromise;
    if (data?.user?.phone) {
        usersPhonePromise = models.users.findOne({ phone: data?.user?.phone });
    }
    if (data?.user?.email) {
        usersEmailPromise = models.users.findOne({ email: data?.user?.email });
    }

    const usersResolved = await Promise.all([usersPhonePromise, usersEmailPromise]);
    let user = usersResolved[0] || usersResolved[1];

    if (!user) {
        user = await models.users.create({
            phone: data?.user?.phone,
            email: data?.user?.email,
            name: data?.user?.name || 'Guest',
            context: data?.user?.context || {},
        });
    }

    data.user = user;
    req.data = data;

    return req;
}

export default getUsers;