// Pre-renders a page at build time by running the page's own script against a tiny fake DOM,
// then writing what it put into each element straight into the HTML. Search engines and link
// previews then see the full content without running JavaScript, and the page shows its
// content instantly. The page's script still runs in the browser and renders the same thing.
//
// Works for elements whose template content is empty or plain text (no nested tag of the same
// name inside), which is how the RimBlaze templates mark their render targets.

import vm from 'node:vm';

const escText = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export async function prerender(html, { ids, fetchMap = {}, hostname = 'rimblaze.com', hash = '' }) {
  const json = {};
  html.replace(/<script type="application\/json" id="([^"]+)">([\s\S]*?)<\/script>/g, (m, id, body) => { json[id] = body; });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const els = {};
  const el = id => els[id] || (els[id] = {
    id, _html: null, _text: json[id] ?? '', _textSet: false, hidden: false, value: '', disabled: false, dataset: {}, style: {},
    set innerHTML(v) { this._html = String(v); }, get innerHTML() { return this._html ?? ''; },
    set textContent(v) { this._text = String(v); this._html = null; this._textSet = true; }, get textContent() { return this._text; },
    setAttribute() {}, getAttribute() { return null; }, appendChild() {}, addEventListener() {},
    matches() { return false; }, closest() { return null; }, classList: { add() {}, remove() {}, toggle() {} },
  });
  const document = {
    title: '', documentElement: { dataset: {} },
    getElementById: el,
    querySelector: sel => (/rb-prod/.test(sel) && /name="rb-prod"/.test(html)) ? {} : null,
    querySelectorAll: () => [],
    createElementNS: () => ({ setAttribute() {}, appendChild() {}, textContent: '' }),
    addEventListener() {},
  };
  const m = /<html[^>]*data-board="([a-z]+)"/.exec(html); if (m) document.documentElement.dataset.board = m[1];
  const ctx = vm.createContext({
    document, window: { addEventListener() {} }, location: { hash, hostname, pathname: '/' }, history: { replaceState() {} },
    fetch: async url => {
      const key = Object.keys(fetchMap).find(k => String(url).includes(k));
      if (!key) throw new Error('offline at build time');
      return { ok: true, status: 200, json: async () => fetchMap[key] };
    },
    matchMedia: () => ({ matches: false }), setTimeout: () => 0, setInterval: () => 0, clearTimeout() {},
    AbortController, console, Date, Intl, Math, JSON, Promise, Object, Array, String, Number,
  });
  for (const s of scripts) vm.runInContext(s, ctx, { timeout: 5000 });
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); // let fetch().then(...) chains finish

  let out = html;
  for (const id of ids) {
    const e = els[id]; if (!e) continue;
    const content = e._html != null ? e._html : (e._textSet ? escText(e._text) : null);
    if (content == null && !e.hidden) continue;
    const re = new RegExp(`(<([a-zA-Z0-9]+)\\b[^>]*\\bid="${id}"[^>]*?)(\\s+hidden)?>([\\s\\S]*?)(</\\2>)`);
    out = out.replace(re, (all, open, tag, wasHidden, inner, close) => `${open}${e.hidden ? ' hidden' : ''}>${content ?? inner}${close}`);
  }
  return { html: out, title: document.title };
}
