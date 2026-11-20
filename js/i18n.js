// The site's languages: English (the source) and Bulgarian.
//
// Each language has its own address (English at the root, Bulgarian at /bg/). A first visit to the root goes to the
// reader's last choice, else the first of the browser's preferred languages that the site has (index.html's head). The interface text is in the tables below, keyed by name. Text in the data (catalog, countries,
// interests) sits next to its English source in a `bg` object: { "name": "Council", "bg": { "name": "Съвет" } }.
// Where a Bulgarian text is missing, the English one is shown.

export const LANGS = ['en', 'bg'];
const NAMES = { en: 'English', bg: 'Български' };

// The language is in the address: /bg/… is Bulgarian, the root English. (A small script in index.html's head sends a
// reader who prefers Bulgarian from the root to /bg/ before the page loads.)
const PREFIX = /^\/(bg)(\/|$)/;
export const lang = (location.pathname.match(PREFIX) || [])[1] || 'en';
document.documentElement.lang = lang;

const STRINGS = {
  en: {
    'site.name': 'Freedom Map',
    'menu.whatIsFreedom': 'What is freedom',
    'menu.lang': 'Language',
    'scale.label': 'Chip colours', 'scale.teal': 'Teal', 'scale.red': 'Red', 'scale.grey': 'Grey',
    'search.placeholder': 'Search an address or place…', 'search.label': 'Address or place', 'search.button': 'Search',
    'search.searching': 'Searching…', 'search.nothing': 'Nothing found for “{q}”.',
    'start.title': 'How free are you where you live, and why?',
    'start.lead': 'Pick any address. Freedom Map shows how free a person living there is to pursue their individual and group interests at each level, from the home to the country. It explains what in the laws makes it so, and how to fix them where they fall short.',
    'start.locate': 'Use my location', 'start.try': 'Try:', 'start.orMap': 'or choose on the map.',
    'try.lozenets': 'Lozenets, Sofia', 'try.langstrasse': 'Langstrasse, Zürich', 'try.ranelagh': 'Ranelagh, Dublin',
    'locate.finding': 'Finding your location…', 'locate.unavailable': 'Your location is not available. Search for an address or choose on the map.',
    'map.label': 'Map. Click anywhere to choose a location.',
    'sample.label': 'What the colours mean', 'sample.link': 'What is freedom →',
    'nav.trail': 'Where you are', 'nav.tree': 'Freedom tree',
    'foot.credits': 'Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Geocoding by <a href="https://nominatim.org/">Nominatim</a> · <a href="docs/DATA.md">About the data</a>',
    'busy.lookingUp': 'Looking up…',
    'place.lookingUp': 'Looking up this location…', 'place.notFound': 'No address found here.', 'place.error': 'Could not look up this location: {msg}',
    'geo.timeout': 'the geocoding service (OpenStreetMap Nominatim) did not answer within 15 seconds; please try again', 'geo.failed': 'Geocoding failed ({status})',
    'alts.other': 'Other matches: ', 'alts.hint': ' Not the right place? Try the street’s full name.',
    'places.mostViewed': 'Your most viewed place ({n} views)', 'places.recent': 'Recently viewed', 'places.example': 'Example',
    'interests.saveError': 'Could not save the list of interests ({msg}).', 'interests.reorder': '{label}. Drag, or press ← →, to reorder.',
    'interests.removeFrom': 'Remove “{label}” from the list for {where}', 'interests.notApplicable': 'Not applicable here: {label}',
    'interests.markNA': 'Mark “{label}” as not applicable here', 'interests.newPlaceholder': 'New interest', 'interests.newLabel': 'New shared interest', 'interests.add': '+ Add',
    'legend.free': 'Free', 'legend.mostlyFree': 'Mostly free', 'legend.mostlyNotFree': 'Mostly not free', 'legend.notFree': 'Not free',
    'legend.effective': 'Effective', 'legend.flawed': 'Flawed', 'legend.ineffective': 'Ineffective or absent',
    'legend.met': 'Met', 'legend.partlyMet': 'Partly met', 'legend.notMet': 'Not met', 'legend.doesNotApply': 'Does not apply', 'legend.notAssessed': 'Not assessed',
    'switch.level': 'Switch level', 'switch.mech': 'Switch institution', 'switch.prop': 'Switch requirement',
    'kind.level': 'Level', 'kind.mech': 'Institution', 'kind.prop': 'Design requirement',
    'branch.direct': 'Direct', 'branch.representative': 'Representative',
    'heading.levels': 'Common interest levels', 'heading.categories': 'Common interest categories',
    'heading.coreInst': 'Core decision-making institutions', 'heading.otherInst': 'Other governance institutions', 'heading.designReq': 'Design requirements',
    'trail.atEachLevel': '{mech} at each level', 'trail.reqAtEachLevel': '{mech} › {prop} at each level',
    'trail.institutions': '{level}: institutions', 'trail.requirements': '{mech}: requirements',
    'trail.naThere': '{label}: this requirement does not apply there. Opens the institution’s page.', 'trail.doesNotApply': '{label}: does not apply',
    'inst.informal': 'Informal', 'inst.none': 'None', 'inst.noneTitle': 'No such institution at this level.', 'inst.otherNone': 'None listed yet',
    'req.disabledTitle': 'Does not apply: the institution does not exist in law.',
    'nodata': 'No data for {country} yet.', 'nodata.thisCountry': 'this country',
    'fix.approved': 'Approved', 'fix.approve': 'Approve', 'fix.yourWording': 'Your wording for {ref}', 'fix.submit': 'Submit', 'fix.cancel': 'Cancel',
    'fix.writeOwn': 'Write my own', 'fix.byReader': 'Suggested by a reader',
    'explainer.source': 'Source: ', 'explainer.more': 'Read more', 'explainer.less': 'Show less',
    'law.fix': 'Fix', 'law.showCurrent': 'Show current law', 'law.withFixes': 'With these amendments (proposed by Freedom Map, not law).',
    'law.absent': 'The act has no provision for this.', 'law.absentFixable': 'The act has no provision for this. Press Fix to see the articles that would provide it.',
    'law.notInLang': '', 'law.unofficial': 'Unofficial translation.',
    'chat.button': 'Comment or ask about this requirement', 'chat.title': 'Comment or ask', 'chat.close': 'Close', 'chat.drag': 'Drag to move',
    'chat.placeholder': 'Comment, suggest an edit, or ask a question', 'chat.label': 'Your message', 'chat.send': 'Send',
    'chat.intro': 'Ask about this requirement, or tell us what you think should change. Your messages are saved for the Freedom Map editors.',
    'comment.button': 'Ask or comment about this passage', 'comment.title': 'About this passage',
    'comment.intro': '“Ask Claude” discusses the highlighted text with Claude. “Send to editors” sends what you wrote, with this conversation, to the Freedom Map editors.', 'comment.ask': 'Ask Claude',
    'comment.placeholder': 'Ask a question, or write your comment', 'comment.post': 'Send to editors', 'comment.empty': 'Write your comment first.',
    'comment.posted': 'Sent to the editors.', 'comment.needsAccount': 'Sending to the editors needs an account. Sign-in is coming soon.',
    'chat.thinking': 'Thinking…', 'chat.noAnswer': 'No answer.', 'chat.needsServer': 'The chat needs the Freedom Map server (server.py). Your message was not saved.',
    'boot.loadError': 'Could not load data ({msg}). Start the site with "python3 server.py".',
  },
  // Draft (Claude, 2026-11-19): the terms follow the glossary awaiting the owner's review.
  bg: {
    'site.name': 'Карта на свободата',
    'menu.whatIsFreedom': 'Какво е свобода',
    'menu.lang': 'Език',
    'scale.label': 'Цветове на бутоните', 'scale.teal': 'Синьозелено', 'scale.red': 'Червено', 'scale.grey': 'Сиво',
    'search.placeholder': 'Търсете адрес или място…', 'search.label': 'Адрес или място', 'search.button': 'Търсене',
    'search.searching': 'Търсене…', 'search.nothing': 'Няма резултати за „{q}“.',
    'start.title': 'Колко сте свободни там, където живеете, и защо?',
    'start.lead': 'Изберете който и да е адрес. Картата на свободата показва колко свободен е човек, който живее там, да преследва личните и груповите си интереси на всяко ниво, от дома до държавата. Тя обяснява какво в законите го прави такъв и как да се поправят там, където не стигат.',
    'start.locate': 'Използвай местоположението ми', 'start.try': 'Пробвайте:', 'start.orMap': 'или изберете на картата.',
    'try.lozenets': 'Лозенец, София', 'try.langstrasse': 'Лангщрасе, Цюрих', 'try.ranelagh': 'Ранела, Дъблин',
    'locate.finding': 'Търсим местоположението ви…', 'locate.unavailable': 'Местоположението ви не е достъпно. Потърсете адрес или изберете на картата.',
    'map.label': 'Карта. Щракнете където и да е, за да изберете място.',
    'sample.label': 'Какво означават цветовете', 'sample.link': 'Какво е свобода →',
    'nav.trail': 'Къде се намирате', 'nav.tree': 'Дърво на свободата',
    'foot.credits': 'Картни данни © сътрудници на <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Геокодиране чрез <a href="https://nominatim.org/">Nominatim</a> · <a href="docs/DATA.md">За данните</a>',
    'busy.lookingUp': 'Търсене…',
    'place.lookingUp': 'Търсим това място…', 'place.notFound': 'Тук не е намерен адрес.', 'place.error': 'Мястото не може да бъде намерено: {msg}',
    'geo.timeout': 'услугата за геокодиране (OpenStreetMap Nominatim) не отговори до 15 секунди; опитайте отново', 'geo.failed': 'Геокодирането не успя ({status})',
    'alts.other': 'Други резултати: ', 'alts.hint': ' Не е това място? Напишете пълното име на улицата.',
    'places.mostViewed': 'Най-разглежданото ви място ({n} прегледа)', 'places.recent': 'Наскоро разгледано', 'places.example': 'Пример',
    'interests.saveError': 'Списъкът с интереси не беше запазен ({msg}).', 'interests.reorder': '{label}. Плъзнете или натиснете ← →, за да преместите.',
    'interests.removeFrom': 'Премахни „{label}“ от списъка за {where}', 'interests.notApplicable': 'Не се отнася за това място: {label}',
    'interests.markNA': 'Отбележи, че „{label}“ не се отнася за това място', 'interests.newPlaceholder': 'Нов интерес', 'interests.newLabel': 'Нов общ интерес', 'interests.add': '+ Добави',
    'legend.free': 'Свободни', 'legend.mostlyFree': 'По-скоро свободни', 'legend.mostlyNotFree': 'По-скоро несвободни', 'legend.notFree': 'Несвободни',
    'legend.effective': 'Действена', 'legend.flawed': 'С недостатъци', 'legend.ineffective': 'Недействена или липсва',
    'legend.met': 'Изпълнено', 'legend.partlyMet': 'Частично изпълнено', 'legend.notMet': 'Неизпълнено', 'legend.doesNotApply': 'Неприложимо', 'legend.notAssessed': 'Неоценено',
    'switch.level': 'Друго ниво', 'switch.mech': 'Друга институция', 'switch.prop': 'Друго изискване',
    'kind.level': 'Ниво', 'kind.mech': 'Институция', 'kind.prop': 'Изискване към устройството',
    'branch.direct': 'Преки', 'branch.representative': 'Представителни',
    'heading.levels': 'Нива на общите интереси', 'heading.categories': 'Видове общи интереси',
    'heading.coreInst': 'Основни институции за вземане на решения', 'heading.otherInst': 'Други институции на управление', 'heading.designReq': 'Изисквания към устройството',
    'trail.atEachLevel': '{mech} на всяко ниво', 'trail.reqAtEachLevel': '{mech} › {prop} на всяко ниво',
    'trail.institutions': '{level}: институции', 'trail.requirements': '{mech}: изисквания',
    'trail.naThere': '{label}: изискването не се отнася там. Отваря страницата на институцията.', 'trail.doesNotApply': '{label}: неприложимо',
    'inst.informal': 'Неформално', 'inst.none': 'Няма', 'inst.noneTitle': 'На това ниво няма такава институция.', 'inst.otherNone': 'Все още няма',
    'req.disabledTitle': 'Неприложимо: институцията не е предвидена в закона.',
    'nodata': 'Все още няма данни за {country}.', 'nodata.thisCountry': 'тази държава',
    'fix.approved': 'Одобрена', 'fix.approve': 'Одобрявам', 'fix.yourWording': 'Вашата редакция на {ref}', 'fix.submit': 'Изпрати', 'fix.cancel': 'Отказ',
    'fix.writeOwn': 'Ще напиша моя', 'fix.byReader': 'Предложена от читател',
    'explainer.source': 'Източник: ', 'explainer.more': 'Още', 'explainer.less': 'По-малко',
    'law.fix': 'Поправка', 'law.showCurrent': 'Покажи действащия закон', 'law.withFixes': 'С тези изменения (предложени от Картата на свободата, не са закон).',
    'law.absent': 'Актът не съдържа разпоредба за това.', 'law.absentFixable': 'Актът не съдържа разпоредба за това. Натиснете „Поправка“, за да видите членовете, които биха я въвели.',
    'law.notInLang': 'Текстът е още на английски; преводът предстои.', 'law.unofficial': 'Неофициален превод.',
    'chat.button': 'Коментар или въпрос за това изискване', 'chat.title': 'Коментар или въпрос', 'chat.close': 'Затвори', 'chat.drag': 'Плъзнете, за да преместите',
    'chat.placeholder': 'Коментирайте, предложете промяна или задайте въпрос', 'chat.label': 'Вашето съобщение', 'chat.send': 'Изпрати',
    'chat.intro': 'Попитайте за това изискване или ни кажете какво според вас трябва да се промени. Съобщенията ви се запазват за редакторите на Картата на свободата.',
    'comment.button': 'Въпрос или коментар за този откъс', 'comment.title': 'За този откъс',
    'comment.intro': '„Попитай Claude“ обсъжда маркирания текст с Claude. „Изпрати на редакторите“ изпраща написаното, заедно с този разговор, на редакторите на Картата на свободата.', 'comment.ask': 'Попитай Claude',
    'comment.placeholder': 'Задайте въпрос или напишете коментара си', 'comment.post': 'Изпрати на редакторите', 'comment.empty': 'Първо напишете коментара си.',
    'comment.posted': 'Изпратено на редакторите.', 'comment.needsAccount': 'За да изпращате на редакторите, е нужен профил. Скоро ще може да влизате в профил.',
    'chat.thinking': 'Мисля…', 'chat.noAnswer': 'Няма отговор.', 'chat.needsServer': 'Чатът изисква сървъра на Картата на свободата (server.py). Съобщението ви не е запазено.',
    'boot.loadError': 'Данните не могат да се заредят ({msg}). Пуснете сайта с „python3 server.py“.',
  },
};

/** Interface text in the reader's language, with {name} placeholders filled from `vars`. */
export function t(key, vars) { return tIn(lang, key, vars); }

/** Interface text in a given language. */
export function tIn(l, key, vars) {
  const s = STRINGS[l]?.[key] ?? STRINGS.en[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : s;
}

/** A field of a data object in the reader's language: `obj.bg.name` for a Bulgarian reader when it exists, else `obj.name`. */
export function tx(obj, field) {
  if (!obj) return undefined;
  const v = lang !== 'en' ? obj[lang]?.[field] : undefined;
  return v ?? obj[field];
}

/** The same page in another language: same place and path (the hash), under that language's address. */
export function langHref(to) {
  const rest = location.pathname.replace(PREFIX, '/');
  return (to === 'en' ? '' : `/${to}`) + rest + location.search + location.hash;
}

/**
 * Fill the page's fixed text: elements marked data-i18n (text), data-i18n-html (trusted markup from the tables
 * above), data-i18n-placeholder, data-i18n-aria-label, data-i18n-title. Adds the language button after the colour toggle.
 */
export function applyStatic(root = document) {
  for (const n of root.querySelectorAll('[data-i18n]')) {
    // In the header, each text also holds its other-language version, hidden, so it takes the width of the longer one
    // and the language button stays in the same place in every language (Orlin).
    if (n.closest('.top')) {
      // Each version carries its own lang, so the browser draws it the same way on every page (with lang="bg" some
      // fonts switch to Bulgarian letter shapes, which changed the widths by a few pixels between the two pages).
      const both = (l, cls, hidden) => { const sp = document.createElement('span'); sp.className = cls; sp.lang = l; sp.textContent = tIn(l, n.dataset.i18n); if (hidden) sp.setAttribute('aria-hidden', 'true'); return sp; };
      n.replaceChildren(both(lang, 'l-cur'), ...LANGS.filter(l => l !== lang).map(l => both(l, 'l-alt', true)));
      n.classList.add('l-both');
    } else n.textContent = t(n.dataset.i18n);
  }
  for (const n of root.querySelectorAll('[data-i18n-html]')) n.innerHTML = t(n.dataset.i18nHtml);
  for (const [attr, data] of [['placeholder', 'i18nPlaceholder'], ['aria-label', 'i18nAriaLabel'], ['title', 'i18nTitle']]) {
    for (const n of root.querySelectorAll(`[data-${attr === 'aria-label' ? 'i18n-aria-label' : `i18n-${attr}`}]`)) n.setAttribute(attr, t(n.dataset[data]));
  }
  if (lang !== 'en') document.title = t('site.name');
  // The language button, right of the colour toggle (Orlin): one button naming the other language (БГ or EN).
  const scale = root.querySelector('#scale');
  if (scale && !root.querySelector('#lang')) {
    const other = LANGS.find(l => l !== lang);
    const box = document.createElement('div');
    box.className = 'scale'; box.id = 'lang';
    const b = document.createElement('button');
    b.type = 'button'; b.lang = other; b.title = NAMES[other];
    b.setAttribute('aria-label', `${tIn(other, 'menu.lang')}: ${NAMES[other]}`);
    // Holds both labels, the current one hidden, so the button is equally wide on every page.
    const tag = l => l === 'bg' ? 'БГ' : 'EN';
    b.classList.add('l-both');
    b.replaceChildren(...[other, lang].map((l, i) => { const sp = document.createElement('span'); sp.className = i ? 'l-alt' : 'l-cur'; sp.lang = l; sp.textContent = tag(l); if (i) sp.setAttribute('aria-hidden', 'true'); return sp; }));
    // Same place and page in the other language (the hash is read at click time).
    b.addEventListener('click', () => {
      try { localStorage.setItem('freedom-lang', other); } catch { /* storage unavailable */ }
      location.href = langHref(other);
    });
    box.append(b);
    scale.after(box);
  }
}
