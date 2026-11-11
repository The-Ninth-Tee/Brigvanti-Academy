import { pay } from '../lib/pay-env.mjs';
// GET plan details, POST cancel or withdraw.
export default (req) => pay.manage(req);
