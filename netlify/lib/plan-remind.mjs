// Daily plan checks, by email. No push messages about payments.
//   yearly   one email 30 days before a yearly plan ends. It never renews by itself.
//   failed   one email 3 days after a failed monthly due date
//   end      Plus ends 5 days after a failed due date that is still unpaid
import { FAIL_MAIL_DAYS, GRACE_DAYS } from './pay.mjs';

export const YEAR_MAIL_DAYS = 30;
const DAY = 864e5;

export function planActions(bill, now) {
  const out = [];
  if (!bill || bill.status !== 'active') return out;
  const left = bill.periodEnd - now;
  if (bill.interval === 'year' && left > 0 && left <= YEAR_MAIL_DAYS * DAY && bill.yearMailedFor !== bill.periodEnd) out.push('yearly');
  if (bill.interval === 'month' && bill.failedAt && !bill.cancelled) {
    if (now >= bill.periodEnd + GRACE_DAYS * DAY) out.push('end');
    else if (now >= bill.periodEnd + FAIL_MAIL_DAYS * DAY && bill.failMailedFor !== bill.periodEnd) out.push('failed');
  }
  return out;
}
