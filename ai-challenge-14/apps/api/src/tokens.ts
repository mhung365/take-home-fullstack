/** LoadedConfig: workflow + users, validated before the app is created. */
export const WORKFLOW_CONFIG = Symbol('WORKFLOW_CONFIG');

/** WorkflowStore implementation used by the engine. */
export const WORKFLOW_STORE = Symbol('WORKFLOW_STORE');

/** The pg.Pool shared by the store and /health; closed on application shutdown. */
export const PG_POOL = Symbol('PG_POOL');
