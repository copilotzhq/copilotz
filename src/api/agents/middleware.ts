import {
    getUser,
    getCopilotz,
    getConfig,
    getJob,
} from './_middlewares/main.js';

async function middleware(this: any, req: any) {
    
    const middlewares = [
        getUser,
        getCopilotz,
        getConfig,
        getJob,
    ];

    for (const middlewareFn of middlewares) {
        req = await middlewareFn.bind(this)(req);
    }

    req.params = { ...req.params, ...req.data };

    return req;

}

export default middleware;