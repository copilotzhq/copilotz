import * as specParsers from "./specParsers/main.js";

const actionExecutor = async ({ specs, specType, module: moduleUrl, config }) => {

    const functions = {};

    // change spectType to all minuscles and replace "-" with "_"
    specType = specType.toLowerCase().replace(/-/g, '_');

    const parsedSpecs = specParsers[specType]({ specs, config });

    
    // example parsedSpecs: 
    // globals:{},
    // actions: [{
    //     "name": "functionName",
    //     "schemas":[
    //         {
    //             "key": "body",
    //             "value": bodySchema,
    //             "validator": validator
    //         },
    //         {
    //             "key": "query",
    //             "value": queryParamsSchema,
    //             "validator": validator
    //         },
    //         {
    //             "key": "path",
    //             "value": pathParamsSchema,
    //             "validator": validator
    //         },
    //         {
    //             "key": "headers",
    //             "value": headersParamsSchema,
    //             "validator": validator
    //         },
    //         {
    //             "key": "response",
    //             "value": responseSchame,
    //             "validator": validator
    //         },
    //     ],
    //     "options":options,
    //     "spec": spec,
    // }...];

    if (moduleUrl.startsWith('native:')) {
        moduleUrl = new URL(`./modules/${moduleUrl.replace('native:', '')}/main.js`, import.meta.url).href;
    }

    if (!(moduleUrl.startsWith('http') || moduleUrl.startsWith('native') || moduleUrl.startsWith('file:'))) {
        throw new Error(`Invalid Module URL: namespace for ${moduleUrl} not found. Should either start with 'http:', 'https:', or 'native:'.`);
    }
    
    await Promise.all(parsedSpecs.actions.map(async ({ name, spec, ...data }) => {
        const mod = await import(moduleUrl).then(m => m.default);

        const fn = mod.bind({ ...data, config: { ...config, ...parsedSpecs.globals } });
        fn.spec = spec;
        functions[name] = fn;
        return fn;
    }))

    return functions;
}

export default actionExecutor;