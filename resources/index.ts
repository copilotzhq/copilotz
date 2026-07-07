import manifest from "./manifest.ts";

export { admin as adminFeature, default as features } from "./features/mod.ts";
export { manifest };

export const bundledResourcesUrl: string = new URL("./", import.meta.url).href;
