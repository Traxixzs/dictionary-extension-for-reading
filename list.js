const rowsEl = document.getElementById('rows');
const wrapEl = document.getElementById('wrap');
const emptyEl = document.getElementById('empty');
const noMatchEl = document.getElementById('nomatch');
const countEl = document.getElementById('count');
const searchEl = document.getElementById('q');

let entries = [];

// ---------- Construction du DOM (jamais d'innerHTML : le texte vient de pages web) ----------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

function highlighted(sentence, word) {
  const at = sentence.toLowerCase().indexOf(word.toLowerCase());
  if (at < 0) return document.createTextNode(sentence);
  const frag = document.createDocumentFragment();
  frag.append(
    sentence.slice(0, at),
    el('mark', { text: sentence.slice(at, at + word.length) }),
    sentence.slice(at + word.length)
  );
  return frag;
}

function translationCell(text, className) {
  const td = el('td', { class: className });
  if (text) td.textContent = text;
  else td.append(el('span', { class: 'missing', text: '—' }));
  return td;
}

function row(entry) {
  const actions = el('td', { class: 'actions' });

  if (!entry.wordTr || !entry.sentenceTr) {
    const retry = el('button', {
      class: 'icon-btn',
      type: 'button',
      title: 'Retraduire',
      'aria-label': 'Retraduire cette entrée',
      text: '↻',
    });
    retry.addEventListener('click', async () => {
      retry.disabled = true;
      await chrome.runtime.sendMessage({ type: 'RETRY', id: entry.id });
    });
    actions.append(retry);
  }

  if (/^https?:/i.test(entry.url)) {
    actions.append(
      el('a', {
        class: 'icon-btn',
        href: entry.url,
        target: '_blank',
        rel: 'noopener noreferrer',
        title: entry.title || 'Ouvrir la page source',
        'aria-label': 'Ouvrir la page source',
        text: '↗',
      })
    );
  }

  const del = el('button', {
    class: 'icon-btn delete',
    type: 'button',
    title: 'Supprimer',
    'aria-label': 'Supprimer cette entrée',
    text: '✕',
  });
  del.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'DELETE', id: entry.id }));
  actions.append(del);

  const sentenceCell = el('td', { class: 'sentence' });
  sentenceCell.append(highlighted(entry.sentence, entry.word));

  return el(
    'tr',
    {},
    el('td', { class: 'word', text: entry.word }),
    sentenceCell,
    translationCell(entry.wordTr, 'word fr'),
    translationCell(entry.sentenceTr, 'sentence fr'),
    actions
  );
}

// ---------- Affichage ----------

function plural(n, one, many) {
  return `${n} ${n > 1 ? many : one}`;
}

function render() {
  const term = searchEl.value.trim().toLowerCase();
  const shown = term
    ? entries.filter((e) =>
        [e.word, e.sentence, e.wordTr, e.sentenceTr].some((v) => (v || '').toLowerCase().includes(term))
      )
    : entries;

  rowsEl.replaceChildren(...shown.map(row));

  const hasEntries = entries.length > 0;
  emptyEl.hidden = hasEntries;
  wrapEl.hidden = !hasEntries;
  noMatchEl.hidden = !hasEntries || shown.length > 0;
  countEl.textContent = !hasEntries
    ? ''
    : term
      ? `${shown.length} sur ${plural(entries.length, 'entrée', 'entrées')}`
      : plural(entries.length, 'entrée', 'entrées');
}

async function load() {
  const data = await chrome.storage.local.get('entries');
  entries = data.entries || [];
  render();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.entries) {
    entries = changes.entries.newValue || [];
    render();
  }
});

searchEl.addEventListener('input', render);

// ---------- Export CSV (séparateur « ; », lisible par Excel, Sheets et Anki) ----------

function csvCell(value) {
  const s = String(value ?? '');
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

document.getElementById('export').addEventListener('click', () => {
  if (entries.length === 0) return;
  const lines = entries.map((e) =>
    [e.word, e.sentence, e.wordTr, e.sentenceTr].map(csvCell).join(';')
  );
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `dico-light-novel-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

document.getElementById('clear').addEventListener('click', () => {
  if (entries.length === 0) return;
  if (confirm('Effacer toute la liste ? Cette action est définitive.')) {
    chrome.runtime.sendMessage({ type: 'CLEAR' });
  }
});

load();
