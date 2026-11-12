// Payment emails, English and Dutch. Dutch text is reviewed by Robbie before it ships.
// The welcome email is also the confirmation of the contract on a durable medium,
// so it carries the plan, the price, the 14 days to withdraw and the terms as a PDF.

const TZ = 'Europe/Amsterdam';
const day = (ms, l) => new Date(ms).toLocaleDateString(l === 'nl' ? 'nl-NL' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ });
const eur = (v, l) => (l === 'nl' ? `€ ${String(v).replace('.', ',')}` : `€${v}`);

const FOOT = {
  en: 'The Ninth Tee, Rijswijkstraat 199, 1062 XL Amsterdam, the Netherlands. Chamber of Commerce number 98566903. Questions: support@theninthtee.eu. Payments and privacy: legal@theninthtee.eu.',
  nl: 'The Ninth Tee, Rijswijkstraat 199, 1062 XL Amsterdam, Nederland. KvK-nummer 98566903. Vragen: support@theninthtee.eu. Betalingen en privacy: legal@theninthtee.eu.',
};
const KEEP = {
  en: 'Your progress and your portfolio always stay saved, also without Plus. They are only removed when you choose Reset account or Delete my account.',
  nl: 'Je voortgang en je portfolio blijven altijd bewaard, ook zonder Plus. Ze worden alleen verwijderd als je kiest voor Reset account of Verwijder mijn account.',
};

const T = {
  welcome: {
    en: (d) => ({
      subject: 'Welcome to Brigvanti Plus',
      lines: [
        'Thank you for choosing Brigvanti Plus. This email confirms your order.',
        d.interval === 'month'
          ? `Your plan: Plus, monthly, ${eur(d.amount, 'en')} a month, including VAT.`
          : `Your plan: Plus, yearly, ${eur(d.amount, 'en')} for one year, including VAT.`,
        d.renewing
          ? `Your new period starts on ${day(d.periodStart, 'en')}, when your current one ends.`
          : `Plus started on ${day(d.startedAt, 'en')}.`,
        d.interval === 'month'
          ? `Plus renews every month until you cancel. Your next payment is on ${day(d.periodEnd, 'en')}. You can cancel at any time in Account.`
          : `Plus ends on ${day(d.periodEnd, 'en')}. It does not renew by itself. We email you 30 days before it ends.`,
        d.renewing
          ? `You can withdraw until ${day(d.withdrawUntil, 'en')}. If you withdraw before your new period starts, you get everything back. After that, you pay for the days you used.`
          : `You asked us to start Plus straight away. You can withdraw until ${day(d.withdrawUntil, 'en')}. If you withdraw, you pay for the days you used and get the rest back.`,
        'To withdraw, open Account and choose Withdraw from contract, or email legal@theninthtee.eu.',
        'The terms and conditions are attached to this email as a PDF.',
        KEEP.en,
      ],
    }),
    nl: (d) => ({
      subject: 'Welkom bij Brigvanti Plus',
      lines: [
        'Bedankt dat je voor Brigvanti Plus hebt gekozen. Met deze e-mail bevestigen we je bestelling.',
        d.interval === 'month'
          ? `Je abonnement: Plus, per maand, ${eur(d.amount, 'nl')} per maand, inclusief btw.`
          : `Je abonnement: Plus, per jaar, ${eur(d.amount, 'nl')} voor één jaar, inclusief btw.`,
        d.renewing
          ? `Je nieuwe periode start op ${day(d.periodStart, 'nl')}, als je huidige periode afloopt.`
          : `Plus is gestart op ${day(d.startedAt, 'nl')}.`,
        d.interval === 'month'
          ? `Plus wordt elke maand verlengd totdat je opzegt. Je volgende betaling is op ${day(d.periodEnd, 'nl')}. Je kunt op elk moment opzeggen in de accountinstellingen.`
          : `Plus stopt op ${day(d.periodEnd, 'nl')}. Het wordt niet automatisch verlengd. We mailen je 30 dagen voordat het afloopt.`,
        d.renewing
          ? `Je kunt annuleren tot ${day(d.withdrawUntil, 'nl')}. Annuleer je voordat je nieuwe periode start, dan krijg je alles terug. Daarna betaal je voor de dagen die je hebt gebruikt.`
          : `Je hebt gevraagd om Plus direct te starten. Je kunt annuleren tot ${day(d.withdrawUntil, 'nl')}. Annuleer je, dan betaal je voor de dagen die je hebt gebruikt en krijg je de rest terug.`,
        'Annuleren doe je in de accountinstellingen met Overeenkomst annuleren, of per e-mail naar legal@theninthtee.eu.',
        'De algemene voorwaarden zitten als pdf bij deze e-mail.',
        KEEP.nl,
      ],
    }),
  },
  paid: {
    en: (d) => ({
      subject: 'Payment received for Brigvanti Plus',
      lines: [`We received your payment of ${eur(d.amount, 'en')} on ${day(d.paidAt, 'en')}.`, `Plus is paid until ${day(d.periodEnd, 'en')}.`],
    }),
    nl: (d) => ({
      subject: 'Betaling ontvangen voor Brigvanti Plus',
      lines: [`We hebben je betaling van ${eur(d.amount, 'nl')} ontvangen op ${day(d.paidAt, 'nl')}.`, `Plus is betaald tot ${day(d.periodEnd, 'nl')}.`],
    }),
  },
  cancelled: {
    en: (d) => ({
      subject: 'Your Brigvanti Plus is cancelled',
      lines: ['This email confirms that you cancelled Plus.', `Plus stays until ${day(d.periodEnd, 'en')}. After that you are on Free, and no further payments are taken.`, KEEP.en],
    }),
    nl: (d) => ({
      subject: 'Je Brigvanti Plus is opgezegd',
      lines: ['Met deze e-mail bevestigen we dat je Plus hebt opgezegd.', `Plus blijft actief tot ${day(d.periodEnd, 'nl')}. Daarna heb je Gratis en schrijven we niets meer af.`, KEEP.nl],
    }),
  },
  withdrawn: {
    en: (d) => ({
      subject: 'Your withdrawal is confirmed',
      lines: [
        'This email confirms that you withdrew from your Brigvanti Plus contract.',
        Number(d.refund) > 0 ? `We refund ${eur(d.refund, 'en')} within 14 days, to the account or card you paid with.` : 'There is nothing to refund.',
        d.keepUntil ? `Your earlier paid period stays until ${day(d.keepUntil, 'en')}.` : 'Plus has stopped. You are now on Free.',
        KEEP.en,
      ],
    }),
    nl: (d) => ({
      subject: 'Je annulering is bevestigd',
      lines: [
        'Met deze e-mail bevestigen we dat je je Brigvanti Plus-overeenkomst hebt geannuleerd.',
        Number(d.refund) > 0 ? `We betalen ${eur(d.refund, 'nl')} binnen 14 dagen terug op de rekening of kaart waarmee je hebt betaald.` : 'Er valt niets terug te betalen.',
        d.keepUntil ? `Je eerder betaalde periode blijft actief tot ${day(d.keepUntil, 'nl')}.` : 'Plus is gestopt. Je hebt nu Gratis.',
        KEEP.nl,
      ],
    }),
  },
  yearly: {
    en: (d) => ({
      subject: 'Your Brigvanti Plus year ends soon',
      lines: [
        `Your Plus year ends on ${day(d.periodEnd, 'en')}. It does not renew by itself.`,
        'To keep Plus, renew it yourself in Account. Your new year starts when the current one ends, so you lose no days.',
        'If you do not renew, you move to Free.',
        KEEP.en,
      ],
    }),
    nl: (d) => ({
      subject: 'Je Brigvanti Plus-jaar loopt bijna af',
      lines: [
        `Je Plus-jaar loopt af op ${day(d.periodEnd, 'nl')}. Het wordt niet automatisch verlengd.`,
        'Wil je Plus houden, verleng het dan zelf in de accountinstellingen. Je nieuwe jaar start als het huidige afloopt, dus je mist geen dagen.',
        'Verleng je niet, dan ga je over naar Gratis.',
        KEEP.nl,
      ],
    }),
  },
  failed: {
    en: (d) => ({
      subject: 'Your Brigvanti Plus payment did not go through',
      lines: [
        'Your last monthly payment for Plus did not go through.',
        `Pay before ${day(d.until, 'en')} to keep Plus. Open Account in the app and choose Pay now.`,
        'If it is not paid by then, your Plus contract ends and you move to Free.',
        KEEP.en,
      ],
    }),
    nl: (d) => ({
      subject: 'Je betaling voor Brigvanti Plus is niet gelukt',
      lines: [
        'Je laatste maandbetaling voor Plus is niet gelukt.',
        `Betaal voor ${day(d.until, 'nl')} om Plus te houden. Open de accountinstellingen in de app en kies Nu betalen.`,
        'Is er dan nog niet betaald, dan stopt je Plus-overeenkomst en ga je over naar Gratis.',
        KEEP.nl,
      ],
    }),
  },
};

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function planMail(kind, data, appUrl) {
  const l = data.lang === 'nl' ? 'nl' : 'en';
  const { subject, lines } = T[kind][l](data);
  const hi = l === 'nl' ? 'Hoi,' : 'Hi,';
  const open = l === 'nl' ? 'Open Brigvanti' : 'Open Brigvanti';
  const link = `${appUrl}/?pay=status`;
  const text = [hi, '', ...lines.flatMap((x) => [x, '']), `${open}: ${link}`, '', FOOT[l]].join('\n');
  // Table layout and inline styles, so Outlook and Gmail show it the same way.
  const logo = `${appUrl}/Icons/app-icon-192.png`;
  const html = `<!doctype html><html lang="${l}"><body style="margin:0;padding:0;background:#F2F1F7">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2F1F7"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:#FFFFFF;border-radius:16px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#1B1830">
<tr><td style="background:#0B0B14;padding:18px 28px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td><img src="${logo}" width="36" height="36" alt="" style="display:block;border:0;border-radius:9px"></td>
<td style="padding-left:12px;font-size:20px;font-weight:700;color:#FFFFFF">Brigvanti</td></tr></table></td></tr>
<tr><td style="padding:28px 28px 8px"><h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#1B1830">${esc(subject)}</h1>
<p style="margin:0 0 14px;font-size:15px;line-height:1.55">${hi}</p>
${lines.map((x) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55">${esc(x)}</p>`).join('')}</td></tr>
<tr><td style="padding:4px 28px 28px"><a href="${link}" style="display:inline-block;background:#C6F432;color:#0B0B14;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:700;font-size:15px">${open}</a></td></tr>
<tr><td style="padding:18px 28px;background:#F7F6FB;border-top:1px solid #E6E4EF;font-size:12px;line-height:1.5;color:#6B6880">${esc(FOOT[l])}</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html, lang: l };
}
