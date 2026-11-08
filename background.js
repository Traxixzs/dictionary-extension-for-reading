// Langue lue -> langue de traduction. Change ici si besoin (codes ISO : en, fr, es, de, ja…).
const SOURCE_LANG = 'en';
const TARGET_LANG = 'fr';

// ---------- Ouverture de la liste ----------

chrome.action.onClicked.addListener(openList);

async function openList() {
  const url = chrome.runtime.getURL('list.html');
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['TAB'],
      documentUrls: [url],
    });
    if (contexts.length > 0) {
      const { tabId, windowId } = contexts[0];
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(windowId, { focused: true });
      return;
    }
  } catch (_) {
    // Navigateur sans getContexts : on ouvre simplement un nouvel onglet.
  }
  await chrome.tabs.create({ url });
}

// ---------- Traduction ----------

async function viaGoogle(text) {
  const params = new URLSearchParams({
    client: 'gtx',
    sl: SOURCE_LANG,
    tl: TARGET_LANG,
    dt: 't',
    q: text,
  });
  const res = await fetch('https://translate.googleapis.com/translate_a/single?' + params, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error('google ' + res.status);
  const data = await res.json();
  const out = (data[0] || []).map((part) => part[0] || '').join('').trim();
  if (!out) throw new Error('google: réponse vide');
  return out;
}

async function viaMyMemory(text) {
  const params = new URLSearchParams({ q: text, langpair: `${SOURCE_LANG}|${TARGET_LANG}` });
  const res = await fetch('https://api.mymemory.translated.net/get?' + params, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error('mymemory ' + res.status);
  const data = await res.json();
  if (Number(data.responseStatus) !== 200) throw new Error('mymemory: ' + data.responseStatus);
  const out = (data.responseData?.translatedText || '').trim();
  if (!out) throw new Error('mymemory: réponse vide');
  return out;
}

// Renvoie '' si aucun service ne répond (l'entrée est gardée, on pourra retraduire plus tard).
async function translate(text) {
  if (!text) return '';
  try {
    return await viaGoogle(text);
  } catch (_) {}
  try {
    return await viaMyMemory(text);
  } catch (_) {}
  return '';
}

// ---------- Stockage ----------

async function getEntries() {
  const { entries = [] } = await chrome.storage.local.get('entries');
  return entries;
}

const sameEntry = (a, b) =>
  a.word.toLowerCase() === b.word.toLowerCase() && a.sentence === b.sentence;

const handlers = {
  async ADD({ entry }) {
    const word = String(entry?.word || '').trim();
    const sentence = String(entry?.sentence || '').trim() || word;
    if (!word) return { ok: false, error: 'mot vide' };

    const candidate = { word, sentence };
    if ((await getEntries()).some((e) => sameEntry(e, candidate))) {
      return { ok: true, duplicate: true };
    }

    const sentenceIsWord = sentence.toLowerCase() === word.toLowerCase();
    const [wordTr, sentenceTr] = await Promise.all([
      translate(word),
      sentenceIsWord ? Promise.resolve(null) : translate(sentence),
    ]);

    // On relit juste avant d'écrire pour ne rien écraser pendant la traduction.
    const entries = await getEntries();
    entries.unshift({
      id: crypto.randomUUID(),
      word,
      sentence,
      wordTr,
      sentenceTr: sentenceIsWord ? wordTr : sentenceTr,
      url: String(entry.url || ''),
      title: String(entry.title || ''),
      date: Date.now(),
    });
    await chrome.storage.local.set({ entries });
    return { ok: true };
  },

  async DELETE({ id }) {
    const entries = (await getEntries()).filter((e) => e.id !== id);
    await chrome.storage.local.set({ entries });
    return { ok: true };
  },

  async CLEAR() {
    await chrome.storage.local.set({ entries: [] });
    return { ok: true };
  },

  async RETRY({ id }) {
    const target = (await getEntries()).find((e) => e.id === id);
    if (!target) return { ok: false, error: 'introuvable' };
    const [wordTr, sentenceTr] = await Promise.all([
      target.wordTr ? target.wordTr : translate(target.word),
      target.sentenceTr ? target.sentenceTr : translate(target.sentence),
    ]);
    const entries = (await getEntries()).map((e) =>
      e.id === id ? { ...e, wordTr, sentenceTr } : e
    );
    await chrome.storage.local.set({ entries });
    return { ok: Boolean(wordTr && sentenceTr) };
  },
};

// Toutes les écritures passent par une file d'attente : pas de course entre deux ajouts rapides.
let queue = Promise.resolve();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  queue = queue
    .then(() => handler(msg))
    .catch((err) => ({ ok: false, error: String(err) }))
    .then(sendResponse)
    .catch(() => {});
  return true; // réponse asynchrone
});
