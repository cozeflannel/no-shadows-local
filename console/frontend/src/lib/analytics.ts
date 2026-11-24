/**
 * How the Console itself is used, counted through Google Tag Manager.
 *
 * Off unless a container is named under Settings, Usage tracking (meta.analytics.gtm_container).
 *
 * The container does not run in the Console's own page. A Google tag collects a great deal by itself from the page it is
 * on: the full address (an alert's number, the words searched for), every page change (Settings and People too), the
 * links clicked, the forms filled in. So it is given a page of its own instead: a blank one, out of sight
 * (/api/usage-frame), with no referrer. It is loaded once, the first time a tracked page is opened, and each tracked page
 * opened is told to it there:
 *
 *     page_view              page_location <console>/feed/:alert, page_title "Review feed: an alert"
 *     console_page_view      page_name, page_path, page_section   (the same, as a plain event, for a container's own triggers)
 *
 * What is sent is the page's name and kind only: the address is the route's shape, never the address itself, so no alert
 * number, document id, search or person is in it. Nothing about who is signed in is sent. The tag's own cookies and what a
 * browser sends with any request (its language, screen size, address on the network) go with it as on any tracked site.
 *
 * Not tracked: Settings, People & Admin, Integrations, Routing and AI. They hold configuration, people's addresses and
 * secrets, and one or two admins use them: nothing is learnt from counting them. A session that only ever opens those pages
 * never loads the container, and once it is loaded nothing is sent from them.
 *
 * What the blank page costs: time spent on a page is not measured (the tag never sees the page being read). Page counts,
 * people and sessions are.
 *
 * It is a page of the Console all the same (the tag's cookies need that), so a script published in the container could
 * still reach the Console through it: the container's publishing rights are an admin's rights.
 */

type TagWindow = Window & typeof globalThis & { dataLayer: unknown[]; gtag: (...args: unknown[]) => void };

export interface TrackedPage { name: string; path: string; section: string }

const CONTAINER = /^GTM-[A-Z0-9]{4,12}$/;  // the id goes into a script address: nothing else is ever accepted
const FRAME = "/api/usage-frame";  // under /api so it can never be answered with the Console itself
const MARK = 'meta[name="console-usage-frame"]';
const WAITING = 40;  // pages opened while the container is still loading: held, then sent in order

// An agent alert opens over the Review feed with its number in the query string, not in the path.
const AGENT_ALERT: TrackedPage = { name: "Review feed: an agent alert", path: "/feed/:agent-alert", section: "Daily work" };

// The pages worth counting: where analysts and leads do their work. First match wins.
const PAGES: [RegExp, TrackedPage][] = [
  [/^\/$/, { name: "Dashboard", path: "/", section: "Daily work" }],
  [/^\/feed\/[^/]+$/, { name: "Review feed: an alert", path: "/feed/:alert", section: "Daily work" }],
  [/^\/feed$/, { name: "Review feed", path: "/feed", section: "Daily work" }],
  [/^\/stories(\/.*)?$/, { name: "Stories", path: "/stories", section: "Daily work" }],
  [/^\/agent(\/.*)?$/, { name: "Ask Gemini", path: "/agent", section: "Daily work" }],
  [/^\/temp-check(\/.*)?$/, { name: "Temp check", path: "/temp-check", section: "Look into" }],
  [/^\/velocity(\/.*)?$/, { name: "Post velocity", path: "/velocity", section: "Look into" }],
  [/^\/early(\/.*)?$/, { name: "Early Detection", path: "/early", section: "Look into" }],
  [/^\/escalations(\/.*)?$/, { name: "Emails & T&S", path: "/escalations", section: "Look into" }],
  [/^\/rosters(\/.*)?$/, { name: "Rosters", path: "/rosters", section: "Team and knowledge" }],
  [/^\/workforce(\/.*)?$/, { name: "Workforce", path: "/workforce", section: "Team and knowledge" }],
  [/^\/knowledge(\/.*)?$/, { name: "Knowledge", path: "/knowledge", section: "Team and knowledge" }],
  [/^\/learning(\/.*)?$/, { name: "Knowledge: learning", path: "/learning", section: "Team and knowledge" }],
  [/^\/campaigns(\/.*)?$/, { name: "Campaigns & watches", path: "/campaigns", section: "Team and knowledge" }],
  [/^\/qa-evals$/, { name: "Chatbot QA evaluations", path: "/qa-evals", section: "Records" }],
  [/^\/compare$/, { name: "Agent, Burson and IMs compared", path: "/compare", section: "Records" }],
  [/^\/cases(\/.*)?$/, { name: "Alert records", path: "/cases", section: "Records" }],
  [/^\/suppressed$/, { name: "Suppressed alerts", path: "/suppressed", section: "Records" }],
  [/^\/parity$/, { name: "Our alerts vs Burson's", path: "/parity", section: "Records" }],
  [/^\/outbox$/, { name: "Waiting to post", path: "/outbox", section: "Records" }],
  [/^\/activity$/, { name: "Event log", path: "/activity", section: "Records" }],
  [/^\/breakdowns$/, { name: "Breakdowns", path: "/breakdowns", section: "Records" }],
  [/^\/help(\/.*)?$/, { name: "Help", path: "/help", section: "Help" }],
];

/** The agent alert an address has open, "" when none. */
function agentAlert(pathname: string, search: string): string {
  return /^\/feed\/?$/.test(pathname) ? new URLSearchParams(search).get("agent") ?? "" : "";
}

/** The tracked page an address belongs to, or null when the page is not tracked (admin and setup pages, and anything unknown). */
export function trackedPage(pathname: string, search = ""): TrackedPage | null {
  if (agentAlert(pathname, search)) return AGENT_ALERT;
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return PAGES.find(([shape]) => shape.test(clean))?.[1] ?? null;
}

interface Tag {
  win: TagWindow | null;
  ready: boolean;          // the container's script has run: pages can be told to it
  off: boolean;            // it could not be set up or loaded (a blocker, no network): nothing more is tried this session
  waiting: TrackedPage[];  // opened before it was ready
}

let tag: Tag | null = null;
let last = "";

/** A value made inside the tag's page, so the tag sees an object of its own page and not one of the Console's. */
function made<T>(win: TagWindow, value: T): T {
  return win.JSON.parse(JSON.stringify(value)) as T;
}

/** What the tag is told about a page. The address is the Console's own with the route's shape in place of the real path. */
function about(page: TrackedPage) {
  return { page_location: window.location.origin + page.path, page_title: page.name };
}

function announce(win: TagWindow, page: TrackedPage): void {
  win.dataLayer.push(made(win, { event: "console_page_view", page_name: page.name, page_path: page.path, page_section: page.section }));
}

/** One tracked page opened, told to a container that is already running. The page's name and address go on the event
 *  itself: the tag's own page keeps the title and address it started with, because the tag reads those late, some time
 *  after it starts, and its first page view would otherwise go out under the name of a page opened in the meantime. */
function send(win: TagWindow, page: TrackedPage): void {
  win.gtag("event", "page_view", made(win, about(page)));
  announce(win, page);
}

function stop(state: Tag): void {
  state.off = true;
  state.waiting = [];
}

/** Open the tag's own blank page and load the container in it. `first` is the page that is being opened right now. */
function start(container: string, first: TrackedPage): Tag {
  const state: Tag = { win: null, ready: false, off: false, waiting: [] };
  const frame = document.createElement("iframe");
  frame.title = "Usage tracking";
  frame.tabIndex = -1;
  frame.setAttribute("aria-hidden", "true");
  frame.referrerPolicy = "no-referrer";  // or the tag would read the address of the page that opened it: an alert's number
  // Out of sight but laid out (one dot, off the corner): a page with no size at all counts as scrolled to its end, and the
  // tag would report a scroll each time it starts.
  frame.style.cssText = "position:fixed;left:-10px;top:-10px;width:1px;height:1px;border:0;visibility:hidden;pointer-events:none";
  frame.addEventListener("load", () => {
    try {
      const win = frame.contentWindow as TagWindow | null;
      const doc = frame.contentDocument;
      if (!win || !doc || !doc.querySelector(MARK)) { stop(state); return; }  // not the blank page (signed out, an older server)
      // The tag counts the page it finds itself on when it starts: make that the page being opened. Neither is changed again.
      win.history.replaceState(null, "", first.path);
      doc.title = first.name;
      doc.body.style.cssText = "margin:0;height:4000px";  // far taller than its one dot: never scrolled, so never reported as scrolled
      // The lines given with this container, as given: its command queue and its first command.
      const boot = doc.createElement("script");
      boot.text = "window.dataLayer = window.dataLayer || [];\nfunction gtag(){dataLayer.push(arguments);}\ngtag('js', new Date());";
      doc.head.appendChild(boot);
      // What a Tag Manager container waits for before its Page View triggers fire (its standard install sends this too).
      win.dataLayer.push(made(win, { "gtm.start": Date.now(), event: "gtm.js" }));
      announce(win, first);
      const script = doc.createElement("script");
      script.async = true;
      script.src = `https://www.googletagmanager.com/gtm.js?id=${container}`;
      script.onload = () => {
        state.ready = true;
        state.waiting.splice(0).forEach((page) => send(win, page));
      };
      script.onerror = () => stop(state);
      doc.head.appendChild(script);
      state.win = win;
    } catch {
      stop(state);  // tracking never gets in the way of the work
    }
  }, { once: true });
  frame.src = FRAME;
  document.body.appendChild(frame);
  return state;
}

/** Tell the container a page was opened, when that page is tracked and a container is set. Safe to call on every navigation. */
export function trackPage(container: string | undefined, pathname: string, search = ""): void {
  if (!container || !CONTAINER.test(container)) return;
  try {
    if (window.top !== window.self) return;  // the Console inside a frame is never the one being used
    const page = trackedPage(pathname, search);
    if (!page) { last = ""; return; }
    const opened = `${pathname}|${agentAlert(pathname, search)}`;
    if (opened === last) return;  // the same page again: counted once (the address is only compared here, never sent)
    last = opened;
    if (!tag) { tag = start(container, page); return; }  // the first page is counted by the container itself as it starts
    if (tag.off) return;
    if (tag.ready && tag.win) send(tag.win, page);
    else if (tag.waiting.length < WAITING) tag.waiting.push(page);
  } catch {
    if (tag) stop(tag);  // tracking never gets in the way of the work
  }
}
