/**
 * BrandSafetyGroups.gs - Read-only Google Sheets connector for the `Brand safety groups` worksheet.
 *
 * Loads Social Alert Google Group addresses (Column B) and optional per-group test emails (Column C) at runtime from
 * the `Brand safety groups` tab of the `slrr-agentic-assistant` workbook (`STORE_SHEET_ID`), caching parsed rows in
 * `CacheService` for 60 seconds so zero recipient addresses ever need to be hardcoded in repository files or `Generated.gs`.
 *
 * Tab ownership invariant: strictly read-only. Never creates, clears, formats, or writes to `Brand safety groups`.
 */

const BRAND_SAFETY_GROUPS_TAB_ = 'Brand safety groups';
const BSG_CACHE_PREFIX_ = 'bsg_rows_v2:';
const BSG_CACHE_SEC_ = 60;

const BSG_SYSTEM_SLOTS_ = {
  defaultcc: 'default_cc',
  defaultto: 'default_to',
  fromemail: 'from_email',
  brandsocialsender: 'from_email',
  brandsocialsends: 'from_email',
  tnsurgent: 'tns_urgent',
  tsurgent: 'tns_urgent',
  trustsafetyurgent: 'tns_urgent',
  leadership: 'leadership',
  slrrleads: 'leadership',
};

const BSG_GROUP_ALIASES_ = {
  executives: 'exec_comms',
  executivecomms: 'exec_comms',
  execcomms: 'exec_comms',
  civics: 'civics',
  peoplecomms: 'people_comms',
  stopleaks: 'stop_leaks',
  lss: 'lss',
  lssexecsecurity: 'lss',
  execsecurity: 'lss',
  influencerteam: 'influencer_team',
  gcpa: 'gcpa',
  gsoc: 'gsoc',
  channelowner: 'channel_owner',
  channelowners: 'channel_owner',
};

let BSG_BASE_ = null;

/** Normalized alphanumeric lookup key ("Ads / Merchant Center" -> "adsmerchantcenter"). Pure. */
function bsgNormKey_(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Deduplicated valid email addresses from a cell or list, lowercased. Pure. */
function bsgParseEmails_(raw) {
  const out = [];
  const seen = new Set();
  const list = Array.isArray(raw) ? raw : [raw];
  list.forEach(item => {
    (String(item || '').match(/[^\s<>",;:()]+@[^\s<>",;:()]+/g) || []).forEach(tok => {
      const cleaned = tok.replace(/^[.'"]+|[.'"]+$/g, '').toLowerCase();
      if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(cleaned) && !seen.has(cleaned)) {
        seen.add(cleaned);
        out.push(cleaned);
      }
    });
  });
  return out;
}

/**
 * Parses 2D sheet values (`Google Group Name`, `Google Group Email`, optional `Test Email` in col C)
 * into `[[name, [liveEmails], [testEmails]?], ...]`. Pure.
 */
function bsgParseRows_(values) {
  if (!Array.isArray(values) || !values.length) return [];
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const r = values[i] || [];
    const name = String(r[0] === undefined || r[0] === null ? '' : r[0]).trim();
    const rawEmails = String(r[1] === undefined || r[1] === null ? '' : r[1]).trim();
    const rawTest = String(r[2] === undefined || r[2] === null ? '' : r[2]).trim();
    if (!name || (!rawEmails && !rawTest)) continue;
    const key = bsgNormKey_(name);
    if (i === 0 && (key === 'googlegroupname' || key === 'groupname' || key === 'group' || key === 'product')) {
      continue;
    }
    const emails = bsgParseEmails_(rawEmails);
    const testEmails = bsgParseEmails_(rawTest);
    if (emails.length || testEmails.length) {
      out.push(testEmails.length ? [name, emails, testEmails] : [name, emails]);
    }
  }
  return out;
}

function bsgSnapshotBase_() {
  if (BSG_BASE_ || typeof GEN === 'undefined' || !GEN) return;
  BSG_BASE_ = {
    distribution: JSON.parse(JSON.stringify(GEN.distribution || {})),
    products: JSON.parse(JSON.stringify(GEN.products || [])),
    email: JSON.parse(JSON.stringify(GEN.email || {})),
    leadership: JSON.parse(JSON.stringify(GEN.leadership || {})),
    speedImSender: String((GEN.settings && GEN.settings.speed_im_sender) || ''),
  };
}

function bsgMergeUnique_(a, b) {
  const out = [];
  const seen = new Set();
  [].concat(a || [], b || []).forEach(e => {
    const lc = String(e || '').trim().toLowerCase();
    if (lc && !seen.has(lc)) {
      seen.add(lc);
      out.push(String(e).trim());
    }
  });
  return out;
}

/**
 * Applies `[[groupName, [liveEmails], [testEmails]?], ...]` rows onto `GEN.distribution` (and optional operational slots)
 * from a clean snapshot of `GEN`. Column B live emails populate `pa` / `recipients` as before; optional Column C test
 * emails populate isolated `test_pa` / `test_recipients` slots used only when `Group test emails` (Control row 37) is ON.
 */
function applyBrandSafetyGroups_(rows) {
  if (typeof GEN === 'undefined' || !GEN) return 0;
  bsgSnapshotBase_();
  const keepStandIn = GEN.email ? GEN.email.stand_in : '';
  const keepRecipientsIn = GEN.email ? GEN.email.recipients_in : 'to';

  GEN.distribution = JSON.parse(JSON.stringify(BSG_BASE_.distribution));
  GEN.products = JSON.parse(JSON.stringify(BSG_BASE_.products));
  GEN.email = Object.assign(JSON.parse(JSON.stringify(BSG_BASE_.email)), {
    stand_in: keepStandIn,
    recipients_in: keepRecipientsIn,
    test_default_cc: [],
    test_default_to: [],
    test_tns_urgent: '',
  });
  GEN.leadership = Object.assign(JSON.parse(JSON.stringify(BSG_BASE_.leadership)), {
    test_recipients: [],
  });
  if (GEN.settings) GEN.settings.speed_im_sender = BSG_BASE_.speedImSender;

  const parsed = [];
  const byNorm = {};
  const testByNorm = {};
  (rows || []).forEach(entry => {
    if (!entry) return;
    const name = String(Array.isArray(entry) ? entry[0] : entry.name || '').trim();
    const emails = bsgParseEmails_(Array.isArray(entry) ? entry[1] : entry.emails);
    const testEmails = bsgParseEmails_(Array.isArray(entry) ? entry[2] : entry.test_emails);
    if (!name || (!emails.length && !testEmails.length)) return;
    parsed.push([name, emails, testEmails]);
    const k = bsgNormKey_(name);
    if (k && emails.length) byNorm[k] = bsgMergeUnique_(byNorm[k], emails);
    if (k && testEmails.length) testByNorm[k] = bsgMergeUnique_(testByNorm[k], testEmails);
  });

  const matched = new Set();

  // 1. Optional operational rows (Default CC, Default To, From Email / Brand Social Sender, T&S Urgent, Leadership)
  Object.keys(BSG_SYSTEM_SLOTS_).forEach(k => {
    const emails = byNorm[k] || [];
    const testEmails = testByNorm[k] || [];
    if (!emails.length && !testEmails.length) return;
    matched.add(k);
    const slot = BSG_SYSTEM_SLOTS_[k];
    if (slot === 'default_cc') {
      if (emails.length) GEN.email.default_cc = emails.slice();
      if (testEmails.length) GEN.email.test_default_cc = testEmails.slice();
    } else if (slot === 'default_to') {
      if (emails.length) GEN.email.default_to = emails.slice();
      if (testEmails.length) GEN.email.test_default_to = testEmails.slice();
    } else if (slot === 'from_email' && emails[0]) {
      GEN.email.from_email = emails[0];
      if (GEN.settings) GEN.settings.speed_im_sender = emails[0];
    } else if (slot === 'tns_urgent') {
      if (emails[0]) GEN.email.tns_urgent = emails[0];
      if (testEmails[0]) GEN.email.test_tns_urgent = testEmails[0];
    } else if (slot === 'leadership') {
      if (emails.length) GEN.leadership.recipients = emails.slice();
      if (testEmails.length) GEN.leadership.test_recipients = testEmails.slice();
    }
  });

  const nameByNorm = {};
  parsed.forEach(([name]) => {
    const k = bsgNormKey_(name);
    if (k && !nameByNorm[k]) nameByNorm[k] = name;
  });

  // 2. Product Area distros (match explicit group_name, then name, then aliases)
  (GEN.distribution.products || []).forEach(p => {
    if (p.deprecated) return;
    const cands = [p.group_name, p.name].concat(p.aliases || []).filter(Boolean);
    for (let i = 0; i < cands.length; i++) {
      const ck = bsgNormKey_(cands[i]);
      if (ck && (byNorm[ck] || testByNorm[ck])) {
        matched.add(ck);
        if (byNorm[ck]) p.pa = byNorm[ck].slice();
        if (testByNorm[ck]) p.test_pa = testByNorm[ck].slice();
        const rawSheetName = nameByNorm[ck];
        if (rawSheetName) {
          p.aliases = p.aliases || [];
          if (p.name.toLowerCase() !== rawSheetName.toLowerCase() &&
              !p.aliases.some(a => a.toLowerCase() === rawSheetName.toLowerCase())) {
            p.aliases.push(rawSheetName);
          }
          const gp = (GEN.products || []).find(gpItem => bsgNormKey_(gpItem.name) === bsgNormKey_(p.name) ||
            (gpItem.aliases || []).some(a => bsgNormKey_(a) === ck));
          if (gp) {
            gp.aliases = gp.aliases || [];
            if (gp.name.toLowerCase() !== rawSheetName.toLowerCase() &&
                !gp.aliases.some(a => a.toLowerCase() === rawSheetName.toLowerCase())) {
              gp.aliases.push(rawSheetName);
            }
          }
        }
        break;
      }
    }
  });

  // 3. Non-product specialty groups (Executive Comms <- Executives, Civics, Stop Leaks, People Comms, etc.)
  (GEN.distribution.groups || []).forEach(g => {
    const aliasKeys = Object.keys(BSG_GROUP_ALIASES_).filter(ak => BSG_GROUP_ALIASES_[ak] === g.action_code);
    const cands = [bsgNormKey_(g.name), bsgNormKey_(g.action_code)].concat(aliasKeys).filter(Boolean);
    for (let i = 0; i < cands.length; i++) {
      const ck = cands[i];
      if (byNorm[ck] || testByNorm[ck]) {
        matched.add(ck);
        if (byNorm[ck]) g.recipients = byNorm[ck].slice();
        if (testByNorm[ck]) g.test_recipients = testByNorm[ck].slice();
        break;
      }
    }
  });

  // 4. Regional leads when regional Google Groups exist on the sheet
  (GEN.distribution.regional_leads || []).forEach(rl => {
    const cands = [rl.region].concat(rl.aliases || []).filter(Boolean);
    for (let i = 0; i < cands.length; i++) {
      const ck = bsgNormKey_(cands[i]);
      if (ck && (byNorm[ck] || testByNorm[ck])) {
        matched.add(ck);
        if (byNorm[ck]) rl.recipients = byNorm[ck].slice();
        if (testByNorm[ck]) rl.test_recipients = testByNorm[ck].slice();
        break;
      }
    }
  });

  // 5. Register any newly added product group row not yet in distribution.yaml
  parsed.forEach(([name, emails, testEmails]) => {
    const ck = bsgNormKey_(name);
    if (!ck || matched.has(ck)) return;
    matched.add(ck);
    const prodEntry = { name: name, group_name: name, pa: (emails || []).slice() };
    if (testEmails && testEmails.length) prodEntry.test_pa = testEmails.slice();
    GEN.distribution.products.push(prodEntry);
    if (!(GEN.products || []).some(p => bsgNormKey_(p.name) === ck)) {
      GEN.products.push({ name: name });
    }
  });

  return parsed.length;
}

/** Filters candidate test emails to valid addresses that are NEVER live real recipients (`realRecipientSet_`). Pure. */
function bsgCleanTestEmails_(raw) {
  const realSet = typeof realRecipientSet_ === 'function' ? realRecipientSet_() : new Set();
  return bsgParseEmails_(raw).filter(e => !realSet.has(e));
}

/** Every valid non-live test email configured in Column C of `Brand safety groups`, deduplicated. Pure. */
function bsgAllowedTestEmails_() {
  if (typeof GEN === 'undefined' || !GEN) return [];
  const raw = [];
  const dist = GEN.distribution || {};
  (dist.products || []).forEach(p => { if (p && p.test_pa) raw.push.apply(raw, p.test_pa); });
  (dist.groups || []).forEach(g => { if (g && g.test_recipients) raw.push.apply(raw, g.test_recipients); });
  (dist.regional_leads || []).forEach(rl => { if (rl && rl.test_recipients) raw.push.apply(raw, rl.test_recipients); });
  const em = GEN.email || {};
  if (em.test_default_to) raw.push.apply(raw, em.test_default_to);
  if (em.test_default_cc) raw.push.apply(raw, em.test_default_cc);
  if (em.test_tns_urgent) raw.push(em.test_tns_urgent);
  if (GEN.leadership && GEN.leadership.test_recipients) raw.push.apply(raw, GEN.leadership.test_recipients);
  return bsgCleanTestEmails_(raw);
}

/** Count of distinct groups on `Brand safety groups` that currently have a usable non-live test email in Column C. Pure. */
function bsgTestGroupCount_() {
  if (typeof GEN === 'undefined' || !GEN) return 0;
  const dist = GEN.distribution || {};
  const seen = new Set();
  (dist.products || []).forEach(p => {
    if (p && !p.deprecated && bsgCleanTestEmails_(p.test_pa).length) seen.add('p:' + bsgNormKey_(p.group_name || p.name));
  });
  (dist.groups || []).forEach(g => {
    if (g && bsgCleanTestEmails_(g.test_recipients).length) seen.add('g:' + bsgNormKey_(g.name));
  });
  (dist.regional_leads || []).forEach(rl => {
    if (rl && bsgCleanTestEmails_(rl.test_recipients).length) seen.add('r:' + bsgNormKey_(rl.region));
  });
  return seen.size;
}

/**
 * Matches a specialty group (`Executives` -> `Executive Comms`, `Civics`, `GCPA`, etc.) or regional lead group from
 * `GEN.distribution` when a multi-product or sheet test alert explicitly names a non-product row from `Brand safety groups`.
 * Returns `{kind, name, recipients, test_recipients}` or `null`. Pure.
 */
function resolveSpecialtyGroup_(name) {
  if (typeof GEN === 'undefined' || !GEN) return null;
  const ck = bsgNormKey_(name);
  if (!ck) return null;
  const dist = GEN.distribution || {};
  const aliasCode = BSG_GROUP_ALIASES_[ck] || '';
  for (const g of (dist.groups || [])) {
    if (!g) continue;
    if (bsgNormKey_(g.name) === ck || bsgNormKey_(g.action_code) === ck || (aliasCode && g.action_code === aliasCode)) {
      return {
        kind: 'group',
        name: g.name,
        action_code: g.action_code || '',
        recipients: Array.isArray(g.recipients) ? g.recipients.slice() : [],
        test_recipients: Array.isArray(g.test_recipients) ? g.test_recipients.slice() : [],
      };
    }
  }
  for (const rl of (dist.regional_leads || [])) {
    if (!rl) continue;
    const cands = [rl.region].concat(rl.aliases || []).filter(Boolean);
    if (cands.some(c => bsgNormKey_(c) === ck)) {
      return {
        kind: 'regional',
        name: `${rl.region} regional leads`,
        action_code: '',
        recipients: Array.isArray(rl.recipients) ? rl.recipients.slice() : [],
        test_recipients: Array.isArray(rl.test_recipients) ? rl.test_recipients.slice() : [],
      };
    }
  }
  return null;
}

/**
 * Resolves Column C test email(s) from `Brand safety groups` for a single Social Alert (`t` from `productEmailTargets_`):
 * - Single-product alert (1 product listed): that product's Column C test email(s) go in `to`.
 * - Multi-product alert (2+ products listed): ALL listed products' Column C test email(s) go in `cc` (`to` stays `[]`),
 *   so no product is arbitrarily treated as the "main" `To:` recipient.
 * - Any listed product without a Column C test email is recorded in `skippedGroups` (and if none of the listed products
 *   has a Column C test email, both `to` and `cc` stay `[]` so no email is sent and the skip is logged).
 */
function bsgTestPlanForTarget_(t, extraGroups) {
  const inp = (t && t.input) || {};
  const f = inp.fields || {};
  const esc = inp.escalation || {};
  const dist = (typeof GEN !== 'undefined' && GEN && GEN.distribution) || {};
  const rawNames = typeof allProductsList_ === 'function'
    ? allProductsList_(f, esc)
    : [String(f.product || esc.product || '').trim()].filter(Boolean);

  let to = [];
  let cc = [];
  const matchedGroups = [];
  const skippedGroups = [];
  const seenKeys = new Set();
  const resolvedItems = [];

  rawNames.forEach(pName => {
    const s = String(pName || '').trim();
    if (!s) return;
    const distro = typeof resolveDistro_ === 'function' ? ((resolveDistro_(s) || {}).distro || null) : null;
    const spec = !distro ? resolveSpecialtyGroup_(s) : null;
    const gLabel = (distro && (distro.group_name || distro.name)) || (spec && spec.name) || s;
    const canonKey = bsgNormKey_((distro && distro.name) || (spec && spec.name) || s);
    if (canonKey && seenKeys.has(canonKey)) return;
    if (canonKey) seenKeys.add(canonKey);
    const emails = distro
      ? bsgCleanTestEmails_(distro.test_pa)
      : (spec ? bsgCleanTestEmails_(spec.test_recipients) : []);
    resolvedItems.push({ gLabel, emails });
  });

  const isMultiProduct = resolvedItems.length >= 2;
  if (resolvedItems.length) {
    resolvedItems.forEach(item => {
      if (item.emails.length) {
        matchedGroups.push(item.gLabel);
        if (isMultiProduct) {
          cc = bsgMergeUnique_(cc, item.emails);
        } else {
          to = bsgMergeUnique_(to, item.emails);
        }
      } else {
        skippedGroups.push(item.gLabel);
      }
    });
  } else {
    // Alert with no product field: check any To-eligible specialty group on the alert, then Default To's test email
    const codes = new Set([].concat(esc.groups || [], extraGroups || []).map(x => String(x || '')));
    let groupName = '';
    const specHits = [];
    (dist.groups || []).forEach(g => {
      if (codes.has(g.action_code) && g.placement === 'to_if_no_product_else_cc') {
        const te = bsgCleanTestEmails_(g.test_recipients);
        specHits.push({ name: g.name, emails: te });
        if (!groupName) groupName = g.name;
      }
    });
    const multiSpec = specHits.length >= 2;
    specHits.forEach(sh => {
      if (sh.emails.length) {
        matchedGroups.push(sh.name);
        if (multiSpec) cc = bsgMergeUnique_(cc, sh.emails);
        else to = bsgMergeUnique_(to, sh.emails);
      }
    });
    if (!to.length && !cc.length && GEN && GEN.email && GEN.email.test_default_to) {
      to = bsgCleanTestEmails_(GEN.email.test_default_to);
      if (to.length) matchedGroups.push('Default To');
    }
    if (!to.length && !cc.length) skippedGroups.push(groupName || 'unmapped product');
  }

  if (to.length || cc.length) {
    if (GEN && GEN.email && GEN.email.test_default_cc) {
      cc = bsgMergeUnique_(cc, bsgCleanTestEmails_(GEN.email.test_default_cc));
    }
    const codes = new Set([].concat(esc.groups || [], extraGroups || []).map(x => String(x || '')));
    (dist.groups || []).forEach(g => {
      if (codes.has(g.action_code)) {
        cc = bsgMergeUnique_(cc, bsgCleanTestEmails_(g.test_recipients));
      }
    });
    const planGroups = new Set(((t && t.plan && t.plan.groups) || []).map(g => bsgNormKey_(g)));
    (dist.regional_leads || []).forEach(rl => {
      if (planGroups.has(bsgNormKey_(`${rl.region} regional leads`))) {
        cc = bsgMergeUnique_(cc, bsgCleanTestEmails_(rl.test_recipients));
      }
    });
    if (to.length) {
      const toSet = new Set(to.map(e => e.toLowerCase()));
      cc = cc.filter(e => !toSet.has(e.toLowerCase()));
    }
  }

  const groupName = matchedGroups.length
    ? matchedGroups.join(', ')
    : (skippedGroups.join(', ') || String((t && (t.distroName || t.productLabel)) || f.product || 'unmapped product').trim());
  return { to, cc, groupName, matchedGroups, skippedGroups };
}

/**
 * Reads `Brand safety groups` from `ss` (cached 60 seconds per spreadsheet ID unless `opts.force` is true).
 * Reads Columns A (`Google Group Name`), B (`Google Group Email`), and optional C (`Test Email`).
 * Returns `{present: boolean, rows: [[name, [liveEmails], [testEmails]?], ...]}`. Never throws and never writes to the sheet.
 */
function readBrandSafetyGroupsTab_(ss, opts) {
  if (!ss || typeof ss.getSheetByName !== 'function') return { present: false, rows: [] };
  let sh = null;
  try {
    sh = ss.getSheetByName(BRAND_SAFETY_GROUPS_TAB_);
  } catch (e) {
    return { present: false, rows: [] };
  }
  if (!sh) return { present: false, rows: [] };

  const force = !!(opts && opts.force);
  const sid = typeof ss.getId === 'function' ? String(ss.getId() || 'sheet') : 'sheet';
  const cacheKey = BSG_CACHE_PREFIX_ + sid;
  const cache = typeof CacheService !== 'undefined' && CacheService.getScriptCache
    ? CacheService.getScriptCache()
    : null;
  if (cache && !force) {
    try {
      const raw = cache.get(cacheKey);
      if (raw) {
        const cachedRows = JSON.parse(raw);
        if (Array.isArray(cachedRows)) return { present: true, rows: cachedRows };
      }
    } catch (e) {}
  }

  try {
    const lastRow = typeof sh.getLastRow === 'function' ? sh.getLastRow() : 0;
    const values = lastRow > 0 ? sh.getRange(1, 1, Math.min(lastRow, 500), 3).getValues() : [];
    const rows = bsgParseRows_(values);
    if (cache) {
      try { cache.put(cacheKey, JSON.stringify(rows), BSG_CACHE_SEC_); } catch (e) {}
    }
    return { present: true, rows };
  } catch (e) {
    console.error('could not read Brand safety groups tab: ' + ((e && e.message) || e));
    return { present: false, rows: [] };
  }
}

/** Loads `Brand safety groups` from `ss` (when the tab exists on `ss`) and applies it to `GEN`. Never throws. */
function syncBrandSafetyGroups_(ss, opts) {
  const res = readBrandSafetyGroupsTab_(ss, opts);
  if (!res.present) return 0;
  return applyBrandSafetyGroups_(res.rows);
}
