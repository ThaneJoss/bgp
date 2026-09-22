import website from 'vinext/server/fetch-handler';
import query from '../workers/bgp/src/index.mjs';
import publisher from '../workers/bgp-publisher/src/index.mjs';
import { createWorker } from './worker-routing.mjs';

export default createWorker({ website, query, publisher });
