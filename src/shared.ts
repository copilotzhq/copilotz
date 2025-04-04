import schemas from './schemas/main.js';
import crud from 'axion-modules/features/crud/sqLite.js';
import * as security from 'axion-modules/connectors/security.js';

export default ({ env, ...modules }: Record<string, any>) => {

    const models = crud({
        schemas,
        config: {
            dbPath: env.DB_PATH,
            dbOptions: {
                authToken: env.DB_TOKEN,
            },
            debug: false,
            serializer: 'stringifyArrays',
            addTimestamps: true
        }
    });

    const utils = { security }

    return ({
        ...modules,
        env,
        utils,
        models,
    });

}