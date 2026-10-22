import { InMemoryWorkflowStore } from '../../src/store';
import { runStoreContract } from './contract';

runStoreContract('in-memory', async ({ lockTimeoutMs }) => ({
  store: new InMemoryWorkflowStore({ lockTimeoutMs }),
}));
