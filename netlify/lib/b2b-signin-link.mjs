// Sign-in links for companies with sign-in method emailLink (D13, decided 23 Nov 2026; sender route 1, P1.11).
// Brigvanti creates the link inside the company tenant and sends it through its own mailer, so:
//   - no email ever goes to an address without a seat or admin record,
//   - the answer is the same for every address, so it never reveals who has a seat,
//   - the sender is the Brigvanti mailbox, not noreply@<project>.firebaseapp.com.
// The link only signs in or creates the account. seatgate still checks the seat when the account is created.
import { adminId, contractActive, normEmail } from './b2b-orgs.mjs';

const json = (obj, status = 200) => Response.json(obj, { status });
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Per address: 3 requests in 15 minutes, 10 in 24 hours. Counted for every address, seat or not,
// so a refusal for too many requests says nothing about the seat list.
export const LIMITS = [{ windowMs: 15 * 60 * 1000, max: 3 }, { windowMs: 24 * 60 * 60 * 1000, max: 10 }];
export function overLimit(times, now) {
  return LIMITS.some((l) => times.filter((t) => now - t < l.windowMs).length >= l.max);
}
const keep = (times, now) => times.filter((t) => now - t < LIMITS[LIMITS.length - 1].windowMs);

const FOOT = {
  en: 'The Ninth Tee, Rijswijkstraat 199, 1062 XL Amsterdam, the Netherlands. Chamber of Commerce number 98566903. Questions: support@theninthtee.eu.',
  nl: 'The Ninth Tee, Rijswijkstraat 199, 1062 XL Amsterdam, Nederland. KvK-nummer 98566903. Vragen: support@theninthtee.eu.',
};
// Dutch text needs Robbie's review before it ships.
const T = {
  en: (org) => ({
    subject: 'Your sign-in link for Brigvanti',
    button: 'Sign in to Brigvanti',
    lines: [
      `Use the button below to sign in to Brigvanti through ${org}.`,
      'Open the link on the device where you want to sign in. The link works once. If it no longer works, ask for a new one on the sign-in page.',
      'After you sign in, you can set a password in Account. Then you can also sign in on other devices without a new link.',
      'Did you not ask for this link? Then you can ignore this email. Nobody can sign in without the link.',
    ],
  }),
  nl: (org) => ({
    subject: 'Je inloglink voor Brigvanti',
    button: 'Inloggen bij Brigvanti',
    lines: [
      `Gebruik de knop hieronder om in te loggen bij Brigvanti via ${org}.`,
      'Open de link op het apparaat waarop je wilt inloggen. De link werkt één keer. Werkt hij niet meer, vraag dan een nieuwe aan op de inlogpagina.',
      'Na het inloggen kun je in Account een wachtwoord instellen. Dan kun je ook op andere apparaten inloggen zonder nieuwe link.',
      'Heb je deze link niet aangevraagd? Dan kun je deze e-mail negeren. Zonder de link kan niemand inloggen.',
    ],
  }),
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function planLinkMail(lang, orgName, link, appUrl) {
  const l = lang === 'nl' ? 'nl' : 'en';
  const { subject, button, lines } = T[l](orgName);
  const hi = l === 'nl' ? 'Hoi,' : 'Hi,';
  const text = [hi, '', ...lines.flatMap((x) => [x, '']), `${button}: ${link}`, '', FOOT[l]].join('\n');
  // Same layout as the Plus emails (pay-mail.mjs): table layout and inline styles for Outlook and Gmail.
  const html = `<!doctype html><html lang="${l}"><body style="margin:0;padding:0;background:#F2F1F7">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2F1F7"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:#FFFFFF;border-radius:16px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#1B1830">
<tr><td style="background:#0B0B14;padding:18px 28px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td><img src="${appUrl}/Icons/app-icon-192.png" width="36" height="36" alt="" style="display:block;border:0;border-radius:9px"></td>
<td style="padding-left:12px;font-size:20px;font-weight:700;color:#FFFFFF">Brigvanti</td></tr></table></td></tr>
<tr><td style="padding:28px 28px 8px"><h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#1B1830">${esc(subject)}</h1>
<p style="margin:0 0 14px;font-size:15px;line-height:1.55">${hi}</p>
${lines.map((x) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55">${esc(x)}</p>`).join('')}</td></tr>
<tr><td style="padding:4px 28px 28px"><a href="${esc(link)}" style="display:inline-block;background:#C6F432;color:#0B0B14;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:700;font-size:15px">${esc(button)}</a></td></tr>
<tr><td style="padding:18px 28px;background:#F7F6FB;border-top:1px solid #E6E4EF;font-size:12px;line-height:1.5;color:#6B6880">${esc(FOOT[l])}</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html, lang: l };
}

// store: orgByTenant(t), admin(orgId, id), member(orgId, id), linkTimes(id) -> [ms], setLinkTimes(id, [ms])
// makeLink(tenantId, email, continueUrl) -> link; send({ to, subject, text, html }) -> true|false
export function createB2bSigninLink({ store, makeLink, send, appUrl, now = () => Date.now() }) {
  const SENT = { ok: true, message: 'If this address has a seat, a sign-in link is on its way.' };
  return async (req) => {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    let body;
    try { body = await req.json(); } catch { return json({ error: 'bad_request' }, 400); }
    const email = normEmail(body && body.email);
    const tenantId = String((body && body.tenantId) || '').trim();
    if (!EMAIL.test(email) || !tenantId || tenantId.length > 128) return json({ error: 'bad_request' }, 400);

    const t = now();
    const id = adminId(email);
    const times = await store.linkTimes(id);
    if (overLimit(times, t)) return json({ error: 'too_many', message: 'Too many requests. Try again later.' }, 429);
    await store.setLinkTimes(id, [...keep(times, t), t]);

    const org = await store.orgByTenant(tenantId);
    if (!org || org.signIn !== 'emailLink' || !contractActive(org, t)) return json(SENT);
    const admin = await store.admin(org.orgId, id);
    const seat = admin ? null : await store.member(org.orgId, id);
    if (!admin && !(seat && (seat.status === 'invited' || seat.status === 'active'))) return json(SENT);

    try {
      const link = await makeLink(tenantId, email, `${appUrl}/?b2b=${encodeURIComponent(tenantId)}`);
      const m = planLinkMail(body.lang, org.name, link, appUrl);
      await send({ to: email, subject: m.subject, text: m.text, html: m.html });
    } catch (e) {
      console.error('[b2b-signin-link] not sent', org.orgId, String(e && e.message || e));
    }
    return json(SENT);
  };
}
