import { pay } from '../lib/pay-env.mjs';
export default (req) => pay.webhook(req);
