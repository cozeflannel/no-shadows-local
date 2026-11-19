// A fake SlidesApp (Google Slides, as Apps Script's SlidesApp service shows a deck) for the slide deliveries' tests
// (SlideDeliveries.gs; test/switch_slide_deliveries.test.js). It keeps what those tests need to see: a deck's slides in
// order, each with its layout, its background and its shapes (placeholders copied from the layout, and text boxes), each
// shape's text with a style per character (bold, link, font family, size, colour), and the deck's layouts with their
// names and placeholders. Like the real service:
//
//   - SlidesApp.openById(id) throws for a deck that is not there ("Requested entity was not found.") and for one the
//     account cannot open at all; a deck the account can only view opens, and every change to it throws
//     ("You do not have permission to perform that action.");
//   - getSlides() hands out new objects at every call (compare slides by getObjectId(), never with ===);
//   - getSlideById(id) is null for a slide that is not in the deck; a removed slide throws on any further use;
//   - insertSlide(index, layout) takes one of the deck's own layouts or a SlidesApp.PredefinedLayout name (one the
//     deck's master has, else it throws), and an index from 0 to the number of slides;
//   - a shape's whole text (getText()) ends with a newline that is always there ("abc" reads "abc\n"); getRange(start,
//     end) counts from the range's own start and throws past its end; new text takes the style of the text before it;
//   - the page is 720 x 405 points (getPageWidth / getPageHeight; a deck's `page: {w, h}` changes it) and every shape
//     has its box (getLeft, getTop, getWidth, getHeight): a placeholder the box its layout gives it (`box: {x, y, w, h}`,
//     else a new deck's box for its type), a text box the one it was inserted with.
//
//   const slides = require('./fake_slides')();
//   slides.addDeck({ id, name, access: 'edit' | 'view' | 'none', sharedDrive, owner, editors, page: {w, h}, slides: [{ layout,
//     title, body, background, titleStyle, bodyStyle }], layouts: [{ name, placeholders: [{type, style, box}], background }] })
//   slides.install(g)       g.services.SlidesApp = the fake, and each deck's sharing on g.drive (DriveApp.getFileById)
//   slides.snapshot(id)     every slide of a deck as plain data (to compare before and after)
//   slides.textOf(slideId) / slides.linksOf(slideId) / slides.styleAt(slideId, placeholderType, offset)
//   slides.move(deck, slide, index) / slides.personRemoves(deck, slide)   what a person does in the deck
//   slides.calls            every write: [kind, deck id, detail]
//
// Every address in a test that uses it ends in .test.
'use strict';

const PREDEFINED = ['BLANK', 'CAPTION_ONLY', 'TITLE', 'TITLE_AND_BODY', 'TITLE_AND_TWO_COLUMNS', 'TITLE_ONLY', 'SECTION_HEADER',
  'SECTION_TITLE_AND_DESCRIPTION', 'ONE_COLUMN_TEXT', 'MAIN_POINT', 'BIG_NUMBER'];
const PLACEHOLDERS = ['NONE', 'BODY', 'CHART', 'CLIP_ART', 'CENTERED_TITLE', 'DIAGRAM', 'DATE_AND_TIME', 'FOOTER', 'HEADER',
  'MEDIA', 'OBJECT', 'PICTURE', 'SLIDE_NUMBER', 'SUBTITLE', 'TABLE', 'TITLE', 'SLIDE_IMAGE'];
const enumOf = names => Object.freeze(Object.fromEntries(names.map(n => [n, n])));

const NOT_FOUND = 'Requested entity was not found.';
const NO_ACCESS = 'You do not have permission to access the requested document.';
const VIEW_ONLY = 'You do not have permission to perform that action.';

// A master's layouts as a new Google Slides deck ("Simple light") has them, with the text style of each placeholder
const BASE_STYLE = { bold: false, link: null, fontFamily: 'Arial', fontSize: 14, color: '#000000' };
// a new deck's placeholder boxes (points, on its 720 x 405 page), by placeholder type
const DEFAULT_BOXES = { TITLE: { x: 31.1, y: 22.3, w: 657.9, h: 62.6 }, BODY: { x: 31.1, y: 90.8, w: 657.9, h: 269.1 },
  CENTERED_TITLE: { x: 24.5, y: 58.6, w: 671, h: 161.5 }, SUBTITLE: { x: 24.5, y: 223.2, w: 671, h: 62.4 } };
const boxFor = (type, box) => Object.assign({}, box || DEFAULT_BOXES[type] || { x: 31.1, y: 90.8, w: 657.9, h: 269.1 });
const DEFAULT_LAYOUTS = [
  { name: 'TITLE', placeholders: [{ type: 'CENTERED_TITLE', style: { fontSize: 52 } }, { type: 'SUBTITLE', style: { fontSize: 28, color: '#595959' } }] },
  { name: 'SECTION_HEADER', placeholders: [{ type: 'TITLE', style: { fontSize: 36 } }] },
  { name: 'TITLE_AND_BODY', placeholders: [{ type: 'TITLE', style: { fontSize: 28 } }, { type: 'BODY', style: { fontSize: 18 } }] },
  { name: 'TITLE_ONLY', placeholders: [{ type: 'TITLE', style: { fontSize: 28 } }] },
  { name: 'BLANK', placeholders: [] },
];

/** A '#rrggbb' colour as the service keeps it (lower case); throws for anything else, as setForegroundColor does. */
function hex(c) {
  const s = String(c || '').trim();
  if (!/^#[0-9a-f]{6}$/i.test(s)) throw new Error(`Invalid hex color: ${s}`);
  return s.toLowerCase();
}

/** A Color object for '#rrggbb' (null for none). */
function colorObj(h) {
  if (!h) return null;
  return { getColorType: () => 'RGB', asRgbColor: () => ({ asHexString: () => h, getRed: () => parseInt(h.slice(1, 3), 16),
    getGreen: () => parseInt(h.slice(3, 5), 16), getBlue: () => parseInt(h.slice(5, 7), 16) }) };
}

module.exports = function makeSlides() {
  const decks = new Map();
  const calls = [];
  let seq = 0;
  const nextId = prefix => `${prefix}_${(++seq).toString(36)}`;

  // ---- the model ------------------------------------------------------------------------------------------------

  function makeShape(placeholderType, style, box) {
    return { id: nextId('shape'), placeholderType: placeholderType || 'NONE', base: Object.assign({}, BASE_STYLE, style || {}),
      text: '', styles: [], box: boxFor(placeholderType, box) };
  }

  function makeLayout(spec) {
    return { id: nextId('layout'), name: String(spec.name), displayName: spec.displayName || String(spec.name),
      background: spec.background ? hex(spec.background) : null,
      placeholders: (spec.placeholders || []).map(p => ({ type: p.type, style: Object.assign({}, p.style || {}), box: boxFor(p.type, p.box) })) };
  }

  /** A slide on `layout`: a shape for each of its placeholders (empty, styled as the layout says). */
  function makeSlide(layout) {
    return { id: nextId('slide'), layout, background: null, removed: false,
      shapes: layout.placeholders.map(p => makeShape(p.type, p.style, p.box)) };
  }

  /** Writes `text` into a shape's [start, end) (offsets in its text), the new characters styled like the one before. */
  function splice(shape, start, end, text) {
    const t = String(text);
    const from = shape.styles[start - 1] || shape.styles[end] || shape.base;
    shape.text = shape.text.slice(0, start) + t + shape.text.slice(end);
    shape.styles.splice(start, end - start, ...Array.from({ length: t.length }, () => Object.assign({}, from)));
  }

  function addDeck(spec) {
    const id = String(spec.id);
    const layouts = (spec.layouts || DEFAULT_LAYOUTS).map(makeLayout);
    const deck = { id, name: spec.name || `Deck ${id}`, access: spec.access || 'edit', sharedDrive: !!spec.sharedDrive,
      page: { w: (spec.page && spec.page.w) || 720, h: (spec.page && spec.page.h) || 405 },
      owner: spec.sharedDrive ? null : (spec.owner || 'owner@team.test'),
      editors: (spec.editors || []).slice(), viewers: (spec.viewers || []).slice(), layouts, slides: [], writes: 0 };
    (spec.slides || []).forEach(s => {
      const layout = layouts.find(l => l.name === (s.layout || 'TITLE_AND_BODY'));
      if (!layout) throw new Error(`fake slides: deck ${id} has no layout ${s.layout}`);
      const slide = makeSlide(layout);
      if (s.background) slide.background = hex(s.background);
      const put = (type, text, style) => {
        if (text === undefined) return;
        let shape = slide.shapes.find(x => x.placeholderType === type);
        if (!shape) { shape = makeShape(type, {}); slide.shapes.push(shape); }
        splice(shape, 0, shape.text.length, text);
        if (style) {
          const st = {};
          if (style.fontFamily) st.fontFamily = style.fontFamily;
          if (style.fontSize) st.fontSize = style.fontSize;
          if (style.color) st.color = hex(style.color);
          if (style.bold !== undefined) st.bold = !!style.bold;
          shape.styles.forEach(x => Object.assign(x, st));
        }
      };
      const titleType = layout.placeholders.some(p => p.type === 'CENTERED_TITLE') ? 'CENTERED_TITLE' : 'TITLE';
      const bodyType = layout.placeholders.some(p => p.type === 'SUBTITLE') && !layout.placeholders.some(p => p.type === 'BODY') ? 'SUBTITLE' : 'BODY';
      put(titleType, s.title, s.titleStyle);
      put(bodyType, s.body, s.bodyStyle);
      deck.slides.push(slide);
    });
    decks.set(id, deck);
    return deck;
  }

  // ---- the service's objects ------------------------------------------------------------------------------------

  const canWrite = deck => {
    if (deck.access !== 'edit') throw new Error(VIEW_ONLY);
  };
  const write = (deck, kind, detail) => {
    canWrite(deck);
    deck.writes++;
    calls.push([kind, deck.id, detail]);
  };
  const live = (deck, slide) => {
    if (slide.removed || !deck.slides.includes(slide)) throw new Error('This slide has been deleted or is no longer in the presentation.');
  };

  function textStyle(deck, owner, shape, start, end) {
    const chars = () => { live(deck, owner); return shape.styles.slice(start, end); };
    const same = key => {
      const cs = chars();
      if (!cs.length) return null;
      return cs.every(c => c[key] === cs[0][key]) ? cs[0][key] : null;
    };
    const set = (key, value, kind) => {
      write(deck, kind, `${shape.id}[${start},${end})`);
      live(deck, owner);
      for (let i = start; i < end && i < shape.styles.length; i++) shape.styles[i][key] = value;
      return api;
    };
    const api = {
      setBold: b => set('bold', !!b, 'bold'),
      setLinkUrl: url => {
        if (!/^https?:\/\/\S+$/.test(String(url || ''))) throw new Error(`Invalid URL: ${url}`);
        return set('link', String(url), 'link');
      },
      removeLink: () => set('link', null, 'unlink'),
      setFontFamily: f => set('fontFamily', String(f), 'font'),
      setFontSize: n => {
        if (!(Number(n) > 0)) throw new Error(`Invalid font size: ${n}`);
        return set('fontSize', Number(n), 'size');
      },
      setForegroundColor: c => set('color', hex(typeof c === 'string' ? c : c && c.asRgbColor ? c.asRgbColor().asHexString() : c), 'color'),
      isBold: () => same('bold'),
      hasLink: () => same('link') !== null,
      getLink: () => { const u = same('link'); return u ? { getUrl: () => u, getLinkType: () => 'URL' } : null; },
      getFontFamily: () => same('fontFamily'),
      getFontSize: () => same('fontSize'),
      getForegroundColor: () => colorObj(same('color')),
    };
    return api;
  }

  /** A text range over a shape: `whole` is getText() (its end moves with the text and takes in the closing newline). */
  function textRange(deck, owner, shape, start, end, whole) {
    const lo = () => (whole ? 0 : start);
    const hi = () => (whole ? shape.text.length : end);
    const range = {
      asString: () => { live(deck, owner); return (shape.text + '\n').slice(lo(), whole ? shape.text.length + 1 : hi()); },
      asRenderedString: () => range.asString(),
      getLength: () => { live(deck, owner); return whole ? shape.text.length + 1 : hi() - lo(); },
      getStartIndex: () => lo(),
      getEndIndex: () => (whole ? shape.text.length + 1 : hi()),
      isEmpty: () => (whole ? shape.text.length === 0 : hi() === lo()),
      getRange(s, e) {
        live(deck, owner);
        const len = range.getLength();
        if (!(Number.isInteger(s) && Number.isInteger(e) && s >= 0 && e >= s && e <= len)) {
          throw new Error(`The start and end offsets must be within the text range: got ${s} to ${e} of ${len}.`);
        }
        const a = lo() + s;
        const b = Math.min(lo() + e, shape.text.length);  // the closing newline is never styled apart
        return textRange(deck, owner, shape, a, b, false);
      },
      getTextStyle: () => textStyle(deck, owner, shape, lo(), hi()),
      setText(t) {
        write(deck, 'text', shape.id);
        live(deck, owner);
        const a = lo();
        splice(shape, a, hi(), String(t));
        if (!whole) end = a + String(t).length;
        return textRange(deck, owner, shape, a, a + String(t).length, false);
      },
      appendText(t) {
        write(deck, 'text', shape.id);
        live(deck, owner);
        const a = hi();
        splice(shape, a, a, String(t));
        if (!whole) end = a + String(t).length;
        return textRange(deck, owner, shape, a, a + String(t).length, false);
      },
      insertText(offset, t) {
        write(deck, 'text', shape.id);
        live(deck, owner);
        if (!(Number.isInteger(offset) && offset >= 0 && offset <= hi() - lo())) throw new Error(`Invalid offset ${offset}`);
        const a = lo() + offset;
        splice(shape, a, a, String(t));
        if (!whole) end += String(t).length;
        return textRange(deck, owner, shape, a, a + String(t).length, false);
      },
      clear() {
        write(deck, 'text', shape.id);
        live(deck, owner);
        splice(shape, lo(), hi(), '');
        if (!whole) end = start;
      },
    };
    return range;
  }

  /** A shape's box in points (getLeft, getTop, getWidth, getHeight), as a Shape and a PageElement both have it. */
  function boxGetters(shape) {
    return { getLeft: () => shape.box.x, getTop: () => shape.box.y, getWidth: () => shape.box.w, getHeight: () => shape.box.h };
  }

  /** A Shape (getShapes, insertTextBox): its text; like the real one, it has no asShape(). */
  function shapeObj(deck, owner, shape) {
    return Object.assign(boxGetters(shape), {
      getObjectId: () => shape.id,
      getPageElementType: () => 'SHAPE',
      getShapeType: () => 'TEXT_BOX',
      getPlaceholderType: () => shape.placeholderType,
      getText: () => { live(deck, owner); return textRange(deck, owner, shape, 0, 0, true); },
      remove() { write(deck, 'removeShape', shape.id); owner.shapes = owner.shapes.filter(x => x !== shape); },
    });
  }

  /** A PageElement (getPlaceholder, getPageElements): asShape() gives its Shape; like the real one, it has no getText(). */
  function elementObj(deck, owner, shape) {
    return Object.assign(boxGetters(shape), {
      getObjectId: () => shape.id,
      getPageElementType: () => 'SHAPE',
      asShape: () => shapeObj(deck, owner, shape),
      remove() { write(deck, 'removeShape', shape.id); owner.shapes = owner.shapes.filter(x => x !== shape); },
    });
  }

  function background(deck, owner, own, inherited, isSlide) {
    const colour = () => own() || inherited();
    return {
      getType: () => (colour() ? 'SOLID' : 'NONE'),
      isVisible: () => !!colour(),
      getSolidFill: () => (colour() ? { getColor: () => colorObj(colour()), getAlpha: () => 1 } : null),
      setSolidFill(c) {
        if (!isSlide) throw new Error('fake slides: only a slide\'s background is set here');
        write(deck, 'background', owner.id);
        live(deck, owner);
        owner.background = hex(typeof c === 'string' ? c : c.asRgbColor().asHexString());
      },
    };
  }

  /**
   * A layout's placeholder (Layout.getPlaceholder): its box, and its Shape, whose text style is the one the layout gives
   * a new slide's placeholder (like the real one, it has no getText() itself: asShape() gives the Shape).
   */
  function layoutPlaceholderObj(p) {
    const st = Object.assign({}, BASE_STYLE, p.style || {});
    const shape = {
      getPlaceholderType: () => p.type,
      getText: () => ({
        asString: () => '\n',
        getTextStyle: () => ({ isBold: () => !!st.bold, getFontFamily: () => st.fontFamily, getFontSize: () => st.fontSize,
          getForegroundColor: () => colorObj(st.color ? hex(st.color) : null) }),
      }),
    };
    return Object.assign(boxGetters(p), { getPageElementType: () => 'SHAPE', asShape: () => shape });
  }

  function layoutObj(deck, layout) {
    const l = {
      getObjectId: () => layout.id,
      getLayoutName: () => layout.name,
      getPlaceholders: () => layout.placeholders.map(p => ({ getPlaceholderType: () => p.type })),
      getPlaceholder: type => { const p = layout.placeholders.find(x => x.type === String(type)); return p ? layoutPlaceholderObj(p) : null; },
      getBackground: () => background(deck, layout, () => layout.background, () => null, false),
      _layout: layout,
    };
    return l;
  }

  function slideObj(deck, slide) {
    const o = {
      getObjectId: () => { live(deck, slide); return slide.id; },
      getLayout: () => { live(deck, slide); return layoutObj(deck, slide.layout); },
      getBackground: () => { live(deck, slide); return background(deck, slide, () => slide.background, () => slide.layout.background, true); },
      getPlaceholder(type) {
        live(deck, slide);
        const shape = slide.shapes.find(x => x.placeholderType === String(type));
        return shape ? elementObj(deck, slide, shape) : null;
      },
      getPlaceholders: () => { live(deck, slide); return slide.shapes.filter(x => x.placeholderType !== 'NONE').map(x => elementObj(deck, slide, x)); },
      getShapes: () => { live(deck, slide); return slide.shapes.map(x => shapeObj(deck, slide, x)); },
      getPageElements: () => { live(deck, slide); return slide.shapes.map(x => elementObj(deck, slide, x)); },
      insertTextBox(text, left, top, width, height) {
        write(deck, 'textBox', slide.id);
        live(deck, slide);
        const shape = makeShape('NONE', {}, width > 0 && height > 0 ? { x: Number(left) || 0, y: Number(top) || 0, w: Number(width), h: Number(height) } : null);
        splice(shape, 0, 0, String(text || ''));
        slide.shapes.push(shape);
        return shapeObj(deck, slide, shape);
      },
      remove() {
        write(deck, 'removeSlide', slide.id);
        live(deck, slide);
        deck.slides = deck.slides.filter(x => x !== slide);
        slide.removed = true;
      },
    };
    return o;
  }

  function presentation(deck) {
    const p = {
      getId: () => deck.id,
      getName: () => deck.name,
      getPageWidth: () => deck.page.w,
      getPageHeight: () => deck.page.h,
      getUrl: () => `https://docs.google.com/presentation/d/${deck.id}/edit`,
      getSlides: () => deck.slides.map(s => slideObj(deck, s)),
      getSlideById: id => { const s = deck.slides.find(x => x.id === String(id)); return s ? slideObj(deck, s) : null; },
      getLayouts: () => deck.layouts.map(l => layoutObj(deck, l)),
      insertSlide(index, layoutOrName) {
        canWrite(deck);
        if (!(Number.isInteger(index) && index >= 0 && index <= deck.slides.length)) {
          throw new Error(`The insertion index ${index} is out of range (0 to ${deck.slides.length}).`);
        }
        let layout = null;
        if (layoutOrName && layoutOrName._layout) {
          layout = deck.layouts.includes(layoutOrName._layout) ? layoutOrName._layout : null;
          if (!layout) throw new Error('The layout is not in this presentation.');
        } else {
          const name = String(layoutOrName || 'BLANK');
          if (!PREDEFINED.includes(name)) throw new Error(`Invalid predefined layout: ${name}`);
          layout = deck.layouts.find(l => l.name === name);
          if (!layout) throw new Error(`Could not find a layout in the current master that matches the predefined layout ${name}.`);
        }
        write(deck, 'insertSlide', `${index}:${layout.name}`);
        const slide = makeSlide(layout);
        deck.slides.splice(index, 0, slide);
        return slideObj(deck, slide);
      },
      appendSlide: layoutOrName => p.insertSlide(deck.slides.length, layoutOrName),
    };
    return p;
  }

  const SlidesApp = {
    PredefinedLayout: enumOf(PREDEFINED),
    PlaceholderType: enumOf(PLACEHOLDERS),
    PageBackgroundType: enumOf(['SOLID', 'PICTURE', 'NONE', 'UNSUPPORTED']),
    PageElementType: enumOf(['SHAPE', 'IMAGE', 'TABLE', 'LINE', 'GROUP', 'UNSUPPORTED']),
    ColorType: enumOf(['RGB', 'THEME', 'UNSUPPORTED']),
    openById(id) {
      calls.push(['open', String(id), '']);
      const deck = decks.get(String(id));
      if (!deck) throw new Error(NOT_FOUND);
      if (deck.access === 'none') throw new Error(NO_ACCESS);
      return presentation(deck);
    },
  };

  // ---- for the tests ----------------------------------------------------------------------------------------------

  /** The fake on g (g.services.SlidesApp, for loadBot) and each deck's sharing on g.drive, as DriveApp tells it. */
  function install(g, bot) {
    g.services.SlidesApp = SlidesApp;
    if (bot) bot.SlidesApp = SlidesApp;  // a bot already loaded: the fake as one of its globals
    decks.forEach(deck => share(g, deck));
  }

  /**
   * Puts `deck`'s sharing on g.drive: the bot's account an editor or a viewer as its access says. A deck in a shared
   * drive (spec.sharedDrive) has no owner, and its members are not listed as its editors or viewers by DriveApp: Drive's
   * own API says what the bot's account may do (capabilities.canEdit, on g.pages, as the bot asks it).
   */
  function share(g, deck) {
    const bot = g.session.effective;
    const caps = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(deck.id)}?fields=capabilities%2FcanEdit&supportsAllDrives=true`;
    g.pages.delete(caps);
    if (deck.access === 'none') {
      g.drive.files.set(deck.id, { fail: 'No item with the given ID could be found. Possibly because you have not edited this item or you do not have permission to access it.' });
      return;
    }
    const listed = !deck.sharedDrive;
    g.drive.files.set(deck.id, { name: deck.name, url: `https://docs.google.com/presentation/d/${deck.id}/edit`,
      mimeType: 'application/vnd.google-apps.presentation', owner: deck.owner,
      editors: deck.editors.concat(listed && deck.access === 'edit' ? [bot] : []), viewers: deck.viewers.concat(listed && deck.access === 'view' ? [bot] : []) });
    if (deck.sharedDrive) g.pages.set(caps, { code: 200, body: JSON.stringify({ capabilities: { canEdit: deck.access === 'edit' } }) });
  }

  const deckOf = id => { const d = decks.get(String(id)); if (!d) throw new Error(`fake slides: no deck ${id}`); return d; };
  const slideById = id => {
    for (const d of decks.values()) { const s = d.slides.find(x => x.id === String(id)); if (s) return s; }
    return null;
  };
  const runs = shape => {
    const out = [];
    shape.styles.forEach((st, i) => {
      const key = JSON.stringify(st);
      const last = out[out.length - 1];
      if (last && last.key === key) { last.end = i + 1; last.text += shape.text[i]; } else out.push({ key, start: i, end: i + 1, text: shape.text[i], style: Object.assign({}, st) });
    });
    return out.map(r => ({ start: r.start, end: r.end, text: r.text, style: r.style }));
  };

  /** A deck's slides as plain data: id, layout, background, and each shape's type, text and styled runs. */
  function snapshot(id) {
    return deckOf(id).slides.map(s => ({ id: s.id, layout: s.layout.name, background: s.background,
      shapes: s.shapes.map(x => ({ id: x.id, type: x.placeholderType, text: x.text, runs: runs(x) })) }));
  }

  /** A slide's text, shape by shape (placeholders first as the slide has them), joined by a blank line. */
  function textOf(slideId) {
    const s = slideById(slideId);
    return s ? s.shapes.map(x => x.text).join('\n\n') : null;
  }

  /** A slide's links: [{text, url, type (the shape's placeholder type), start, end}] in the order they stand. */
  function linksOf(slideId) {
    const s = slideById(slideId);
    if (!s) return null;
    const out = [];
    s.shapes.forEach(x => runs(x).filter(r => r.style.link).forEach(r => out.push({ text: r.text, url: r.style.link, type: x.placeholderType, start: r.start, end: r.end })));
    return out;
  }

  /** The style of one character of a slide's shape (by placeholder type, or 'NONE' for a text box). */
  function styleAt(slideId, type, offset) {
    const s = slideById(slideId);
    const shape = s && s.shapes.find(x => x.placeholderType === type);
    return shape && shape.styles[offset] ? Object.assign({}, shape.styles[offset]) : null;
  }

  /** Moves a slide, as a person dragging it in the deck would. */
  function move(deckId, slideId, toIndex) {
    const d = deckOf(deckId);
    const s = d.slides.find(x => x.id === String(slideId));
    if (!s) throw new Error(`fake slides: no slide ${slideId}`);
    d.slides = d.slides.filter(x => x !== s);
    d.slides.splice(toIndex, 0, s);
  }

  /** Deletes a slide, as a person would in the deck (not through the service). */
  function personRemoves(deckId, slideId) {
    const d = deckOf(deckId);
    const s = d.slides.find(x => x.id === String(slideId));
    if (!s) throw new Error(`fake slides: no slide ${slideId}`);
    d.slides = d.slides.filter(x => x !== s);
    s.removed = true;
  }

  return { SlidesApp, decks, calls, addDeck, install, share, snapshot, textOf, linksOf, styleAt, move, personRemoves,
    deck: deckOf, slideIds: id => deckOf(id).slides.map(s => s.id), DEFAULT_LAYOUTS };
};
