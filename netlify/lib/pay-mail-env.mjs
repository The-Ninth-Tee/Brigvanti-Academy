// Sends payment emails through the Hostinger mailbox over SMTP.
// Netlify environment: SMTP_USER (the mailbox, e.g. info@theninthtee.eu), SMTP_PASS,
// optional SMTP_HOST, SMTP_PORT, MAIL_FROM, MAIL_REPLY_TO. Without SMTP_PASS nothing is sent.
// The address comes from the sign in at send time, so billing records hold no email.
import { adminAuth } from './firebase-admin.mjs';
import { planMail } from './pay-mail.mjs';

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

const appUrl = () => (env.APP_URL || env.URL || '').replace(/\/$/, '');

export async function mailPlan(uid, kind, data) {
  if (!env.SMTP_USER || !env.SMTP_PASS) { console.warn('[pay-mail] SMTP not set, skipped', kind); return false; }
  let to;
  try { to = (await adminAuth.getUser(uid)).email; } catch { to = null; }
  if (!to) return false;
  const m = planMail(kind, data, appUrl());
  const attachments = [];
  if (kind === 'welcome') {
    const file = `brigvanti-terms-v1-${m.lang}.pdf`;
    const res = await fetch(`${appUrl()}/legal/${file}`);
    if (!res.ok) throw new Error(`terms pdf ${res.status}`);
    attachments.push({ filename: file, content: Buffer.from(await res.arrayBuffer()), contentType: 'application/pdf' });
  }
  await (await transporter()).sendMail({
    from: env.MAIL_FROM || `Brigvanti <${env.SMTP_USER}>`,
    replyTo: env.MAIL_REPLY_TO || 'support@theninthtee.eu',
    to, subject: m.subject, text: m.text, html: m.html, attachments,
  });
  return true;
}
