// A small fake browser page for the live dashboard's page tests (test/switch_dashboard_page.test.js): just enough of the
// DOM for DashboardJs.html to draw itself and be clicked, with no library. It keeps what those tests look at:
//
//   - elements with their attributes, children, text, classes, style properties, event listeners, and the properties
//     the page sets (hidden, disabled, checked, selected, value); document.getElementById / querySelector(All) with
//     simple selectors (tag, #id, .class, [attr], [attr="value"], several joined by commas; no combinators);
//   - Dashboard.html's <body> parsed into those elements (its template tags and scripts left out), so the page finds its
//     own containers;
//   - a page clock the test moves (performance.now, setTimeout, setInterval: nothing runs until the test says), the
//     device's clock (Date.now) moving with it, and a google.script.run whose calls wait until the test hands them on
//     (to the real bot, or to its own answer).
//
//   const page = require('./fake_dom').loadPage({ run: (fn, args) => answer | throw, viewer })
//   page.flush()          hands every waiting google.script.run call on (the page's promises settle at once: the test
//                         harness runs tests one after the other, synchronously)
//   page.tick(ms)         moves the page clock on, running the timers that come due (and flushing after each)
//   page.sleep(ms)        the device sleeps: its clock (Date.now) moves on, the page clock and its timers do not
//   page.text(el)         an element's text; page.all(sel) / page.one(sel); page.click(el); page.byText(sel, re)
//
// Nothing here is part of the bot or pushed with it.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/**
 * A promise that settles at once and calls its handlers at once (the page only makes them with `new Promise` and reads
 * them with `.then`): the page's answers are drawn as soon as the test hands a call on, with no event loop to wait for.
 */
class SyncPromise {
  constructor(fn) {
    this.state = 'pending';
    this.value = undefined;
    this.handlers = [];
    const settle = (state, value) => {
      if (this.state !== 'pending') return;
      if (state === 'ok' && value && typeof value.then === 'function') { value.then(v => settle('ok', v), e => settle('fail', e)); return; }
      this.state = state;
      this.value = value;
      this.handlers.splice(0).forEach(h => h());
    };
    try { fn(v => settle('ok', v), e => settle('fail', e)); } catch (e) { settle('fail', e); }
  }
  then(ok, fail) {
    return new SyncPromise((resolve, reject) => {
      const run = () => {
        const fn = this.state === 'ok' ? ok : fail;
        if (typeof fn !== 'function') { (this.state === 'ok' ? resolve : reject)(this.value); return; }
        try { resolve(fn(this.value)); } catch (e) { reject(e); }
      };
      if (this.state === 'pending') this.handlers.push(run); else run();
    });
  }
  catch(fail) { return this.then(null, fail); }
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const PROPS = ['hidden', 'disabled', 'checked', 'selected', 'required'];

class Node {
  constructor(doc, type, tag, ns) {
    this.ownerDocument = doc;
    this.nodeType = type;
    this.tagName = tag ? String(tag).toUpperCase() : '';
    this.namespaceURI = ns || '';
    this.attrs = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this.data = '';
    this.listeners = {};
    this.props = {};
    const self = this;
    this.style = {
      props: {},
      setProperty(k, v) { this.props[k] = String(v); },
      removeProperty(k) { delete this.props[k]; },
      getPropertyValue(k) { return this.props[k] || ''; },
    };
    ['background', 'fontFamily', 'color', 'fontSize', 'width', 'height', 'left', 'top'].forEach(k => {
      Object.defineProperty(this.style, k, { get() { return this.props[k] || ''; }, set(v) { this.props[k] = String(v); }, enumerable: true });
    });
    this.classList = {
      list: () => String(self.getAttribute('class') || '').split(/\s+/).filter(Boolean),
      add(...c) { const l = this.list(); c.forEach(x => { if (l.indexOf(x) < 0) l.push(x); }); self.setAttribute('class', l.join(' ')); },
      remove(...c) { self.setAttribute('class', this.list().filter(x => c.indexOf(x) < 0).join(' ')); },
      toggle(c, on) { const has = this.contains(c); const want = on === undefined ? !has : !!on; if (want && !has) this.add(c); if (!want && has) this.remove(c); return want; },
      contains(c) { return this.list().indexOf(c) >= 0; },
    };
  }

  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') || ''; }
  get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map(n => n.textContent).join(''); }
  set textContent(v) {
    if (this.nodeType === 3) { this.data = String(v); return; }
    this.childNodes.forEach(n => { n.parentNode = null; });
    this.childNodes = [];
    if (v !== '' && v !== null && v !== undefined) this.appendChild(this.ownerDocument.createTextNode(String(v)));
  }
  get value() { return this.props.value !== undefined ? this.props.value : (this.getAttribute('value') || ''); }
  set value(v) { this.props.value = String(v); }

  setAttribute(k, v) { this.attrs.set(String(k), String(v)); }
  getAttribute(k) { return this.attrs.has(String(k)) ? this.attrs.get(String(k)) : null; }
  hasAttribute(k) { return this.attrs.has(String(k)); }
  removeAttribute(k) { this.attrs.delete(String(k)); }

  appendChild(n) {
    if (n.nodeType === 11) { n.childNodes.slice().forEach(c => this.appendChild(c)); return n; }
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }
  append(...ns) { ns.forEach(n => this.appendChild(typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n)); }
  insertBefore(n, ref) {
    if (!ref) return this.appendChild(n);
    if (n.parentNode) n.parentNode.removeChild(n);
    const i = this.childNodes.indexOf(ref);
    n.parentNode = this;
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, n);
    return n;
  }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); n.parentNode = null; return n; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceChildren(...ns) {
    this.childNodes.forEach(n => { n.parentNode = null; });
    this.childNodes = [];
    ns.forEach(n => this.appendChild(typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n));
  }
  replaceWith(n) {
    const p = this.parentNode;
    if (!p) return;
    const i = p.childNodes.indexOf(this);
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = p;
    p.childNodes.splice(i, 1, n);
    this.parentNode = null;
  }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }

  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn); }
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    for (let x = this; x; x = x.parentNode) {
      ev.currentTarget = x;
      (x.listeners[ev.type] || []).slice().forEach(fn => fn(ev));
      if (ev.cancelBubble) break;
    }
    return !ev.defaultPrevented;
  }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  scrollIntoView() {}
  closest(sel) { for (let x = this; x && x.nodeType === 1; x = x.parentNode) if (matches(x, sel)) return x; return null; }
  matches(sel) { return matches(this, sel); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = n => n.childNodes.forEach(c => { if (c.nodeType === 1) { if (matches(c, sel)) out.push(c); walk(c); } });
    walk(this);
    return out;
  }
}
PROPS.forEach(k => {
  Object.defineProperty(Node.prototype, k, {
    get() { return this.props[k] !== undefined ? !!this.props[k] : this.hasAttribute(k); },
    set(v) { this.props[k] = !!v; if (v) this.setAttribute(k, ''); else this.removeAttribute(k); },
  });
});

/** Does `el` match a selector: compound parts (tag, #id, .class, [attr], [attr="v"]), descendant spaces, comma lists? */
function matches(el, sel) {
  return String(sel).split(',').map(s => s.trim()).filter(Boolean).some(alt => {
    const parts = alt.split(/\s+/);
    if (!matchOne(el, parts[parts.length - 1])) return false;
    let x = el.parentNode;
    for (let i = parts.length - 2; i >= 0; i--) {
      while (x && x.nodeType === 1 && !matchOne(x, parts[i])) x = x.parentNode;
      if (!x || x.nodeType !== 1) return false;
      x = x.parentNode;
    }
    return true;
  });
}

/** Does `el` match one compound selector (no spaces)? */
function matchOne(el, one) {
  return [one].some(one => {
    const re = /^([a-zA-Z][\w-]*)?((?:#[\w-]+|\.[\w-]+|\[[^\]]+\])*)$/;
    const m = one.match(re);
    if (!m) throw new Error(`fake_dom: selector not supported: ${one}`);
    if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
    const parts = m[2].match(/#[\w-]+|\.[\w-]+|\[[^\]]+\]/g) || [];
    return parts.every(p => {
      if (p[0] === '#') return el.getAttribute('id') === p.slice(1);
      if (p[0] === '.') return el.classList.contains(p.slice(1));
      const a = p.slice(1, -1).match(/^([\w-]+)(?:([~^$*]?=)"?([^"]*)"?)?$/);
      if (!a) throw new Error(`fake_dom: attribute selector not supported: ${p}`);
      if (!el.hasAttribute(a[1])) return false;
      if (!a[2]) return true;
      const v = el.getAttribute(a[1]);
      return a[2] === '=' ? v === a[3] : a[2] === '^=' ? v.startsWith(a[3]) : a[2] === '*=' ? v.includes(a[3]) : a[2] === '$=' ? v.endsWith(a[3]) : v.split(/\s+/).includes(a[3]);
    });
  });
}

function makeDocument() {
  const doc = {
    activeElement: null, visibilityState: 'visible', listeners: {},
    createElement: tag => new Node(doc, 1, tag),
    createElementNS: (ns, tag) => new Node(doc, 1, tag, ns),
    createTextNode: text => { const n = new Node(doc, 3); n.data = String(text); return n; },
    createDocumentFragment: () => new Node(doc, 11),
    getElementById: id => doc.documentElement.querySelector(`#${id}`) || (doc.documentElement.getAttribute('id') === id ? doc.documentElement : null),
    querySelector: sel => doc.documentElement.querySelector(sel),
    querySelectorAll: sel => doc.documentElement.querySelectorAll(sel),
    addEventListener(type, fn) { (doc.listeners[type] = doc.listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { doc.listeners[type] = (doc.listeners[type] || []).filter(f => f !== fn); },
  };
  doc.documentElement = new Node(doc, 1, 'html');
  doc.body = new Node(doc, 1, 'body');
  doc.documentElement.appendChild(doc.body);
  doc.activeElement = doc.body;
  return doc;
}

/** Parses an HTML fragment (no scripts, no template tags) into `parent`. Enough for Dashboard.html's own markup. */
function parseInto(doc, parent, html) {
  const src = String(html).replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '').replace(/<script[\s\S]*?<\/script>/gi, '');
  const stack = [parent];
  const tagRe = /<\/?([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
  let at = 0;
  let m;
  const text = t => { if (t && t.replace(/\s+/g, '')) stack[stack.length - 1].appendChild(doc.createTextNode(t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))); };
  while ((m = tagRe.exec(src))) {
    text(src.slice(at, m.index));
    at = tagRe.lastIndex;
    const closing = m[0][1] === '/';
    const tag = m[1].toLowerCase();
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tagName === tag.toUpperCase()) { stack.length = i; break; }
      continue;
    }
    const el = doc.createElement(tag);
    const attrRe = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let a;
    while ((a = attrRe.exec(m[2]))) el.setAttribute(a[1], a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4] !== undefined ? a[4] : '');
    stack[stack.length - 1].appendChild(el);
    if (!m[3] && !VOID.has(tag)) stack.push(el);
  }
  text(src.slice(at));
}

/**
 * The dashboard's page, loaded as doGet serves it, with DashboardJs.html running in it: {document, window, flush, tick,
 * calls (every google.script.run call: {fn, args}), ...helpers}. `opts.run(fn, args)` answers each call (its return
 * value goes back through a JSON round trip, as google.script.run carries it; a throw is the failure handler's);
 * `opts.hold(fn)` true keeps a call waiting for good (a call that never returns).
 */
function loadPage(opts) {
  const o = opts || {};
  const root = path.join(__dirname, '..');
  const doc = makeDocument();
  const html = fs.readFileSync(path.join(root, 'Dashboard.html'), 'utf8');
  const body = (html.match(/<body>([\s\S]*)<\/body>/) || [])[1] || '';
  parseInto(doc, doc.body, body.replace('<?= viewerEmail ?>', o.viewer || ''));
  const clock = { now: 1000 };
  // the device's clock: the page clock's time plus what the device slept (page.sleep); new Date() and Date.now() read it
  const wall = { base: Date.UTC(2026, 10, 18, 12, 0), slept: 0 };
  const wallNow = () => wall.base + clock.now + wall.slept;
  class PageDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(wallNow()); }
    static now() { return wallNow(); }
  }
  const timers = [];
  let seq = 0;
  const pending = [];
  const calls = [];
  const storage = new Map();
  const run = {};
  const makeRunner = (ok, fail) => new Proxy({}, {
    get(_, name) {
      if (name === 'withSuccessHandler') return fn => makeRunner(fn, fail);
      if (name === 'withFailureHandler') return fn => makeRunner(ok, fn);
      if (typeof name !== 'string' || !/^dash/.test(name)) return undefined;
      return (...args) => {
        calls.push({ fn: name, args: JSON.parse(JSON.stringify(args)) });
        if (o.hold && o.hold(name, args)) return;
        pending.push(() => {
          let answer;
          try {
            answer = o.run(name, JSON.parse(JSON.stringify(args)));
          } catch (e) {
            if (fail) fail(e instanceof Error ? e : new Error(String(e)));
            return;
          }
          const back = answer === undefined ? null : JSON.parse(JSON.stringify(answer));
          if (ok) ok(back);
        });
      };
    },
  });
  Object.defineProperty(run, 'withSuccessHandler', { value: fn => makeRunner(fn, null) });
  Object.defineProperty(run, 'withFailureHandler', { value: fn => makeRunner(null, fn) });
  const window = {
    document: doc,
    google: { script: { run } },
    localStorage: { getItem: k => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    performance: { now: () => clock.now },
  };
  const ctx = {
    window, document: doc, console, Intl, Date: PageDate, Math, JSON, Promise: SyncPromise, Array, Object, String, Number, Boolean, RegExp, Error, Set, Map, Symbol,
    isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    setTimeout: (fn, ms) => { const id = ++seq; timers.push({ id, at: clock.now + Math.max(0, Number(ms) || 0), fn, every: 0 }); return id; },
    clearTimeout: id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
    setInterval: (fn, ms) => { const id = ++seq; timers.push({ id, at: clock.now + Number(ms), fn, every: Number(ms) }); return id; },
    clearInterval: id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
    requestAnimationFrame: fn => { const id = ++seq; timers.push({ id, at: clock.now, fn, every: 0 }); return id; },
    d3: undefined, ResizeObserver: undefined,
  };
  window.setTimeout = ctx.setTimeout;
  window.clearTimeout = ctx.clearTimeout;
  vm.createContext(ctx);
  const js = fs.readFileSync(path.join(root, 'DashboardJs.html'), 'utf8').replace(/^\s*<script>/, '').replace(/<\/script>\s*$/, '');
  vm.runInContext(js, ctx, { filename: 'DashboardJs.html' });

  const page = {
    document: doc, window, calls, clock, timers,
    flush() {
      for (let round = 0; round < 50 && pending.length; round++) {
        while (pending.length) pending.shift()();
      }
    },
    /** Runs the timers due now (a zero-delay timeout, an animation frame), then hands the calls on. */
    settle() { page.tick(0); },
    /** The device sleeps for `ms`: its clock moves on; the page clock (performance.now) and the timers stand still. */
    sleep(ms) { wall.slept += ms; },
    tick(ms) {
      const end = clock.now + ms;
      for (let n = 0; n < 10000; n++) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const t = timers[0];
        if (!t || t.at > end) break;
        clock.now = Math.max(clock.now, t.at);
        if (t.every) t.at += t.every; else timers.shift();
        t.fn();
        page.flush();
      }
      clock.now = end;
      page.flush();
    },
    one: sel => doc.querySelector(sel),
    all: sel => doc.querySelectorAll(sel),
    text: el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : ''),
    click(el) {
      if (!el) throw new Error('fake_dom: nothing to click');
      if (el.disabled) throw new Error('fake_dom: the button is disabled');
      el.dispatchEvent({ type: 'click', preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.cancelBubble = true; } });
      page.settle();
    },
    submit(form) {
      form.dispatchEvent({ type: 'submit', preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.cancelBubble = true; } });
      page.settle();
    },
    type(el, value) {
      el.value = value;
      if (el.tagName === 'INPUT' && (el.getAttribute('type') === 'checkbox' || el.getAttribute('type') === 'radio')) el.checked = !!value;
      el.dispatchEvent({ type: 'input', target: el, preventDefault() {}, stopPropagation() {} });
      el.dispatchEvent({ type: 'change', target: el, preventDefault() {}, stopPropagation() {} });
      page.settle();
    },
    /** The elements matching `sel` whose text matches `re`. */
    byText: (sel, re) => doc.querySelectorAll(sel).filter(el => re.test(el.textContent.replace(/\s+/g, ' '))),
  };
  return page;
}

module.exports = { loadPage, makeDocument, parseInto, matches };
