// The privacy statement promises: payment records are kept for seven years after
// the year of payment, then deleted. Dutch tax law sets the seven years.
export const KEEP_YEARS = 7;
export const PENDING_DAYS = 30;
const DAY = 864e5;

// First moment a payment made at `paidAt` may be deleted: 1 January, 8 years on.
export const purgeFrom = (paidAt) => Date.UTC(new Date(paidAt).getUTCFullYear() + KEEP_YEARS + 1, 0, 1);

// Payments made before this moment are past their retention now.
export const cutoff = (now) => Date.UTC(new Date(now).getUTCFullYear() - KEEP_YEARS, 0, 1);

// What to do with one billing record.
//   delete  no payment inside the retention period, and no plan running
//   keep    otherwise
// A checkout that was never paid holds no payment record, so it goes after 30 days.
export function decide(bill, now) {
  if (!bill) return 'keep';
  if (bill.status === 'active' && (bill.periodEnd || 0) > now) return 'keep';
  if (!bill.lastPaidAt && !bill.firstPaymentId) {
    const at = (bill.consent && bill.consent.at) || 0;
    return now - at > PENDING_DAYS * DAY ? 'delete' : 'keep';
  }
  const paid = bill.lastPaidAt || bill.startedAt || 0;
  return now >= purgeFrom(paid) ? 'delete' : 'keep';
}
