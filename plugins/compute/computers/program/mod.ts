/**
 * The computer program's pool mode, as code (`copilotz/plugins/compute/program`):
 * what each VM of an app's pool of hosted computers runs (`computer pool`, see
 * pool.ts and the pool's names in the computers contract), started in a
 * process of the app's own instead: a local host's VMs in development, and
 * tests. The program's command line is main.ts.
 */
export { type Pool, type PoolOptions, startPool } from "./pool.ts";
