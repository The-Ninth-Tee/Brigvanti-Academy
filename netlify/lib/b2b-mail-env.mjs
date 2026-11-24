// B2B emails through the same Hostinger mailbox as the Plus emails (P1.11, route 1).
// Same Netlify variables as pay-mail-env.mjs: SMTP_USER, SMTP_PASS, optional SMTP_HOST, SMTP_PORT, MAIL_FROM,
// MAIL_REPLY_TO. A separate file, so the payment emails stay untouched (S5).
const env = process.env;
let transport;
async function transporter() {
  if (transport) return transport;
  const { default: nodemailer } = await import('nodemailer');
  transport = nodemailer.createTransport({
    host: env.SMTP_HOST || 'smtp.hostinger.com',
    port: Number(env.SMTP_PORT || 465),
    secure: Number(env.SMTP_PORT || 465) === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  return transport;
}

export const appUrl = () => (env.APP_URL || env.URL || '').replace(/\/$/, '');

export async function sendB2bMail({ to, subject, text, html }) {
  if (!env.SMTP_USER || !env.SMTP_PASS) { console.warn('[b2b-mail] SMTP not set, skipped'); return false; }
  await (await transporter()).sendMail({
    from: env.MAIL_FROM || `Brigvanti <${env.SMTP_USER}>`,
    replyTo: env.MAIL_REPLY_TO || 'support@theninthtee.eu',
    to, subject, text, html,
  });
  return true;
}
