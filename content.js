(() => {
  'use strict';
  if (window.__lnDicoLoaded) return;
  window.__lnDicoLoaded = true;

  const MAX_SELECTION = 200; // au-delà, ce n'est plus un mot ou une expression
  const MAX_SENTENCE = 600;
  const LONG_BLOCK = 5000;
  const CONTEXT_WINDOW = 1500;

  // ---------- Découpage en phrases ----------

  const END_MARKS = '.!?…';
  const CLOSERS = '"\'”’»)]';
  const ABBREVIATION = /(?:^|[^A-Za-z])(?:Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|vs)$/i;

  // Renvoie les intervalles [début, fin[ de chaque phrase.
  // Gère les guillemets de dialogue, les points de suspension et quelques abréviations.
  function splitSentences(text) {
    const spans = [];
    const n = text.length;
    let start = 0;
    let i = 0;
    while (i < n) {
      if (!END_MARKS.includes(text[i])) {
        i++;
        continue;
      }
      let j = i;
      while (j < n && END_MARKS.includes(text[j])) j++;
      let k = j;
      while (k < n && CLOSERS.includes(text[k])) k++;

      let boundary = k >= n || /\s/.test(text[k]);
      const run = text.slice(i, j);
      const isEllipsis = /^(?:\.{2,}|…+)$/.test(run);

      // « I... I didn't mean it » : les points de suspension ne coupent pas, sauf s'ils ferment un dialogue.
      if (boundary && isEllipsis && k === j) boundary = false;

      // « "Wait!" he shouted. » : une minuscule après la ponctuation = suite de la même phrase.
      if (boundary) {
        let p = k;
        while (p < n && /\s/.test(text[p])) p++;
        if (p < n && /[a-z]/.test(text[p])) boundary = false;
      }

      if (boundary && run === '.' && ABBREVIATION.test(text.slice(Math.max(0, i - 5), i))) {
        boundary = false;
      }

      if (boundary) {
        spans.push([start, k]);
        start = k;
      }
      i = k;
    }
    if (start < n) spans.push([start, n]);
    return spans;
  }

  // Phrase(s) couvrant la sélection [start, end[ dans text.
  function findSentence(text, start, end) {
    let from = -1;
    let to = -1;
    for (const [s, e] of splitSentences(text)) {
      if (e <= start) continue;
      if (from < 0) from = s;
      to = e;
      if (e >= end) break;
    }
    return from < 0 ? text.trim() : text.slice(from, to).trim();
  }

  function cleanWord(text) {
    return text
      .replace(/\s+/g, ' ')
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
      .trim();
  }

  function clampSentence(sentence, word) {
    if (sentence.length <= MAX_SENTENCE) return sentence;
    const at = Math.max(0, sentence.toLowerCase().indexOf(word.toLowerCase()));
    const a = Math.max(0, at - 250);
    const b = Math.min(sentence.length, a + MAX_SENTENCE);
    return (a > 0 ? '…' : '') + sentence.slice(a, b) + (b < sentence.length ? '…' : '');
  }

  // ---------- Contexte dans la page ----------

  function blockOf(node) {
    let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      const display = getComputedStyle(el).display;
      if (!display.startsWith('inline') && !display.startsWith('ruby') && display !== 'contents') {
        return el;
      }
      el = el.parentElement;
    }
    return document.body || document.documentElement;
  }

  function getSentence(range, word) {
    const block = blockOf(range.startContainer);

    const all = document.createRange();
    all.selectNodeContents(block);
    let text = all.toString();

    const before = document.createRange();
    before.selectNodeContents(block);
    before.setEnd(range.startContainer, range.startOffset);

    const raw = range.toString();
    let start = before.toString().length + (raw.length - raw.trimStart().length);
    let end = start + raw.trim().length;
    if (!block.contains(range.endContainer)) end = text.length;

    if (text.length > LONG_BLOCK) {
      const a = Math.max(0, start - CONTEXT_WINDOW);
      const b = Math.min(text.length, end + CONTEXT_WINDOW);
      text = text.slice(a, b);
      start -= a;
      end -= a;
    }

    const sentence = findSentence(text, start, end).replace(/\s+/g, ' ').trim();
    return clampSentence(sentence || word, word);
  }

  // ---------- Bouton « Ajouter » ----------

  const STATES = {
    idle: { icon: '+', label: 'Ajouter' },
    loading: { icon: '…', label: 'Traduction…' },
    done: { icon: '✓', label: 'Ajouté' },
    dup: { icon: '✓', label: 'Déjà dans ta liste' },
    error: { icon: '!', label: 'Échec, réessaie' },
    reload: { icon: '!', label: 'Recharge la page' },
  };

  let host = null;
  let button = null;
  let iconEl = null;
  let labelEl = null;
  let hideTimer = 0;
  let current = null;

  function ensureUI() {
    if (host) return;
    host = document.createElement('div');
    host.style.cssText = 'all: initial; position: absolute; z-index: 2147483647; display: none;';
    const root = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = `
      button {
        all: initial;
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 13px 6px 6px;
        border-radius: 999px;
        background: #1e2340;
        color: #fff;
        font: 600 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
        white-space: nowrap;
        cursor: pointer;
        box-shadow: 0 6px 18px rgba(20, 24, 50, 0.3);
      }
      .icon {
        display: grid;
        place-items: center;
        width: 22px;
        height: 22px;
        border-radius: 50%;
        background: #ffe066;
        color: #1e2340;
        font-size: 16px;
        font-weight: 700;
      }
      button:hover .icon { background: #fff; }
      button:focus-visible { outline: 2px solid #ffe066; outline-offset: 2px; }
      button[data-state="loading"] { cursor: progress; }
      button[data-state="error"] .icon,
      button[data-state="reload"] .icon { background: #ff8a80; }
    `;

    button = document.createElement('button');
    button.type = 'button';
    iconEl = document.createElement('span');
    iconEl.className = 'icon';
    labelEl = document.createElement('span');
    button.append(iconEl, labelEl);

    root.append(style, button);
    // Empêche le clic de vider la sélection.
    button.addEventListener('mousedown', (e) => e.preventDefault());
    button.addEventListener('click', onAdd);
    document.documentElement.appendChild(host);
  }

  function setState(name) {
    const state = STATES[name];
    button.dataset.state = name;
    iconEl.textContent = state.icon;
    labelEl.textContent = state.label;
  }

  function show(rect) {
    ensureUI();
    clearTimeout(hideTimer);
    setState('idle');
    host.style.display = 'block';
    const maxLeft = window.scrollX + document.documentElement.clientWidth - 150;
    const left = Math.max(window.scrollX + 4, Math.min(rect.right + window.scrollX, maxLeft));
    host.style.left = left + 'px';
    host.style.top = rect.bottom + window.scrollY + 8 + 'px';
  }

  function hide() {
    clearTimeout(hideTimer);
    if (host) host.style.display = 'none';
    current = null;
  }

  function onSelection() {
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
      return hide();
    }
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return hide();

    const range = selection.getRangeAt(0);
    const word = cleanWord(range.toString());
    if (!word || word.length > MAX_SELECTION || !/\p{L}/u.test(word)) return hide();

    const rects = range.getClientRects();
    if (rects.length === 0) return hide();

    current = { word, sentence: getSentence(range, word) };
    show(rects[rects.length - 1]);
  }

  async function onAdd() {
    if (!current) return;
    clearTimeout(hideTimer);
    setState('loading');
    const entry = { ...current, url: location.href, title: document.title };
    try {
      if (!chrome.runtime?.id) throw new Error('context');
      const res = await chrome.runtime.sendMessage({ type: 'ADD', entry });
      if (!res?.ok) throw new Error(res?.error || 'inconnu');
      setState(res.duplicate ? 'dup' : 'done');
      hideTimer = setTimeout(hide, 1300);
    } catch (_) {
      setState(chrome.runtime?.id ? 'error' : 'reload');
      hideTimer = setTimeout(hide, 2600);
    }
  }

  document.addEventListener(
    'mouseup',
    (e) => {
      if (e.target === host) return;
      setTimeout(onSelection, 10);
    },
    true
  );
  document.addEventListener(
    'mousedown',
    (e) => {
      if (e.target !== host) hide();
    },
    true
  );
  document.addEventListener(
    'keyup',
    (e) => {
      if (e.key === 'Escape') hide();
      else if (e.shiftKey) setTimeout(onSelection, 10);
    },
    true
  );

  // Pour les tests en dehors du navigateur.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { splitSentences, findSentence, getSentence, cleanWord };
  }
})();
