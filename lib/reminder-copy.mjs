/* Fixed reminder texts. The Dutch is a draft for Robbie's review. */
const COPY = {
  en: {
    comeback: (s) => ['Time to practise again',
      s ? `Today is a good day to practise ${s} again. One real task is enough.`
        : 'Today is a good day to practise again. One real task is enough.'],
    levelup: (s) => ['A level up test is open',
      s ? `You have practised enough to try the level up test for ${s}.`
        : 'You have practised enough to try a level up test.'],
    scan: () => ['Your scan is waiting', 'Place your next area in the scan. It takes a few minutes.'],
    start: () => ['Ready for your first assignment?', 'Pick a real task from your week and practise on it.'],
    followup: () => ['Pick up where you left off', 'One real task this week keeps your skills growing.'],
  },
  nl: {
    comeback: (s) => ['Tijd om weer te oefenen',
      s ? `Vandaag is een goede dag om weer te oefenen met ${s}. Eén taak uit de praktijk is genoeg.`
        : 'Vandaag is een goede dag om weer te oefenen. Eén taak uit de praktijk is genoeg.'],
    levelup: (s) => ['Je level up test staat klaar',
      s ? `Je hebt genoeg geoefend om de level up test voor ${s} te doen.`
        : 'Je hebt genoeg geoefend om een level up test te doen.'],
    scan: () => ['Je scan wacht op je', 'Plaats je volgende gebied in de scan. Dat kost maar een paar minuten.'],
    start: () => ['Klaar voor je eerste opdracht?', 'Kies een taak uit je eigen week en oefen ermee.'],
    followup: () => ['Pak de draad weer op', 'Eén taak uit de praktijk deze week houdt je vaardigheden in beweging.'],
  },
};
const ROUTE = { comeback: 'practice', followup: 'practice', start: 'practice', levelup: 'levelup', scan: 'scan' };

export function reminderMessage(lang, kind, skillName) {
  const set = COPY[lang] || COPY.en;
  const k = set[kind] ? kind : 'followup';
  const [title, body] = set[k](skillName || '');
  return { title, body, url: `/?remind=${ROUTE[k]}`, tag: 'brigvanti-reminder' };
}
