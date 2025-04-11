//max value length for sanitization is 100kb
const MAX_VALUE_LENGTH = 1024 * 100;

function sanitizeObject(obj: any): any {
    if (typeof obj !== 'object' || obj === null) {
        return typeof obj === 'string' && obj.length > MAX_VALUE_LENGTH ? 'VALUE_TOO_LARGE' : obj;
    }

    if (Array.isArray(obj)) {
        return obj.map(sanitizeObject);
    }

    return Object.fromEntries(
        Object.entries(obj).map(([key, value]) => [key, sanitizeObject(value)])
    );
}

function beforeRun(this: any, { name, url, requestId, executionId, input, properties }: {
    name: string;
    url: string;
    requestId: string;
    executionId: string;
    input: any;
    properties: any;
}) {

    const pruneInput = (input: any, name: string) => {

        switch (name) {
            case 'chatAgent': {
                const { threadLogs: _threadLogs, instructions: _instructions, resources: _resources, ...rest } = input?.['0'];
                return { ['0']: rest };
            }
            case 'functionCall': {
                const { threadLogs: _threadLogs, instructions: _instructions, resources: _resources, ...rest } = input?.['0'];
                return { ['0']: rest };
            }
            case 'taskManager': {
                const { threadLogs: _threadLogs, instructions: _instructions, resources: _resources, ...rest } = input?.['0'];
                return { ['0']: rest };
            }
            case 'agent': {
                const { threadLogs: _threadLogs, instructions: _instructions, resources: _resources, ...rest } = input?.['0'];
                return { ['0']: rest };
            }
            default: {
                return input;
            }
        }

    }

    const { models } = this;

    if (models?.logs) {
        const sanitizedInput = sanitizeObject({ ...input })
        const tags = properties?.__tags__;
        models.logs.customQuery(`
            INSERT into logs 
            (name, requestId, executionId, input, tags, duration, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [name, requestId, executionId, JSON.stringify(pruneInput(sanitizedInput, name)), JSON.stringify(tags) || null, 1, new Date().toISOString(), new Date().toISOString()]
        )
    }

    return
}

function afterRun(this: any, { status, executionId, output, duration, properties }: {
    name: string;
    url: string;
    requestId: string;
    status: string;
    executionId: string;
    output: any;
    duration: number;
    properties: any;
}) {
    const { models } = this;
    if (models?.logs) {
        // check if output is an Error
        if (output instanceof Error) {
            output = {
                message: output.message,
                stack: output.stack
            }
        }
        const sanitizedOutput = sanitizeObject(output)
        const tags = properties?.__tags__ || {};
        if (typeof sanitizedOutput === 'object' && sanitizedOutput !== null) {
            const { __tags__, ...rest } = sanitizedOutput;
            output = rest;
            __tags__ && Object.assign(tags, __tags__);
        } else {
            output = sanitizedOutput;
        }

        models.logs.customQuery(`
            UPDATE logs 
            SET duration = ?, 
            status = ?, 
            output = ?, 
            tags = ?,
            updatedAt = ?
            WHERE executionId = ?
        `,
            [duration || 1, status, JSON.stringify(output), JSON.stringify(tags) || null, new Date().toISOString(), executionId]
        )
    }
    return
}

export { beforeRun, afterRun }