import website from 'vinext/server/fetch-handler';
import { createWorker } from './worker-routing.mjs';

export default createWorker({ website });
