import actionHandler from './actions/v2/main.ts';

const agents = (name: string) => import(`./agents/${name}/main.js`)
  .then(module => module.default);

const ai = (name: string, provider: string) => import(`./ai/${name}/${provider}/main.js`)
  .then(module => module.default);

export default (shared: any) => {
  return {
    ...shared,
    modules: { agents, ai, actionHandler }
  }
}
