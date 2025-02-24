// What are action modules
// They are generic code that can be used in actions.
// They receive a schema and execute the action.

/**
 * request: receives an object containing the schemas for performing an http request, and validating its response.
 * request (inputSchema, outputSchema) => (data)=> action
 * inputSchema: {body, query, path}
 * outputSchema: {body, status}
 */

// Add these utility functions at the top of the file
function isBase64(str) {
    // Check if value is string and has minimum requirements for base64
    if (typeof str !== 'string') return false;
    if (str.length < 8) return false; // Minimum viable length for data URL
    if (!str.startsWith('data:')) return false;

    const dataUrlRegex = /^data:([a-z]+\/[a-z0-9-+.]+)?;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
    try {
        return dataUrlRegex.test(str);
    } catch {
        return false;
    }
}

function extractBase64Content(obj, path = '', result = {}, original = obj) {
    // Handle null or undefined
    if (obj == null) return result;

    if (Array.isArray(obj)) {
        obj.forEach((item, index) => {
            const newPath = path ? `${path}.${index}` : `${index}`;
            extractBase64Content(item, newPath, result, original);
        });
    } else if (typeof obj === 'object' && obj !== null) {
        Object.entries(obj).forEach(([key, value]) => {
            const newPath = path ? `${path}.${key}` : key;
            extractBase64Content(value, newPath, result, original);
        });
    } else if (isBase64(obj)) {
        result[path] = obj;

        // Remove the base64 content from the original object
        const pathParts = path.split('.');
        let current = original;
        for (let i = 0; i < pathParts.length - 1; i++) {
            current = current[pathParts[i]];
        }
        const lastPart = pathParts[pathParts.length - 1];
        if (Array.isArray(current)) {
            current.splice(parseInt(lastPart), 1);
        } else {
            delete current[lastPart];
        }
    }
    return result;
}

async function request(params) {

    // const { url, method, headers = {}, body, queryParams = {}, pathParams = {} } = this;
    const { schemas, options, config } = this || {};
    // Substitute pathParams in URL

    let url = new URL(options.path, config.baseUrl).href

    // Validate data against schemas
    const data = {};
    schemas.forEach(({ key, validator }) => ['body', 'query', 'path', 'headers'].includes(key) && (data[key] = validator(params)));

    // Substitute pathParams in URL
    data.path && Object.keys(data.path).forEach(key => {
        url = url.replace(`:${key}`, data.path[key]);
    });

    // Add queryParams to URL
    const queryString = new URLSearchParams(data.query).toString();
    if (queryString) {
        url += `?${queryString}`;
    }

    // Configure request options
    const fetchOptions = {
        method: options.method || 'GET',
        headers: {
            'Content-Type': 'application/json',
            ...config.headers, ...data.headers,
        },
        body: data.body ? JSON.stringify(data.body) : undefined
    };

    try {
        // console.log('fetching', url, fetchOptions);
        const response = await fetch(url, fetchOptions);

        const resBody = await response.text();
        let res;

        try {
            res = JSON.parse(resBody);

            // Extract base64 content if response is parsed successfully
            const base64Content = {};
            if (res) {
                extractBase64Content(res, '', base64Content, res);
            }
            // console.log('Response', res)

            // Return both the cleaned response and base64 content
            res = {
                ...res,
                __media__: Object.keys(base64Content).length > 0 ? base64Content : undefined
            };

        } catch (_) {
            // if response is string, check for data url and extract media
            if (typeof resBody === 'string' && isBase64(resBody)) {
                res = { __media__: { [new URL(url).pathname]: resBody } };
            } else {
                res = { data: resBody }
            }
        }

        if (!response.ok) {
            throw { error: { status: response.status, statusText: response.statusText }, ...res };
        }

        return res

    } catch (error) {
        console.error('Error processing request:', error, {
            url,
            method: options.method,
            body: data.body,
            query: data.query,
            path: data.path,
            headers: data.headers,
        });
        throw { error };
    }
};

export default request;


