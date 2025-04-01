import {
    getUser,
    getCopilotz,
    getConfig,
    getJob,
} from './_middlewares/main.js';
import processActions from './_middlewares/actionProcessor.ts';

/**
 * Middleware function for handling requests before they reach the agent
 * 
 * @param {any} req - The request object
 * @returns {Promise<any>} The processed request object
 */
async function middleware(this: any, req: any) {
    // Define middlewares to be executed in sequence
    const middlewares = [
        getUser,
        getCopilotz,
        getConfig,
        getJob,
        processActions,  // Process actions using the new system
    ];

    // Execute each middleware in sequence
    for (const middlewareFn of middlewares) {
        req = await middlewareFn.bind(this)(req);
    }

    // Merge data into params for backward compatibility
    req.params = { ...req.params, ...req.data };

    return req;
}

export default middleware;