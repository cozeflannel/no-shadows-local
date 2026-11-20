/**
 * xposts.js — the words of X posts, from X's public embed data.
 *
 * Brandwatch's API gives X posts without their text, author or link (X's licensing). The chat bot fills them from the
 * same public endpoint X's own "embed this post" code uses; this is that lookup, ported. No login, no key, read-only.
 * A post X won't serve (deleted, protected, age-restricted) is simply left out.
 */
'use strict';

const EMBED = 'https://cdn.syndication.twimg.com/tweet-result';
const UA = 'Mozilla/5.0 (compatible; SLRR-tempcheck/1.0)';

/** The token X's embed endpoint expects for a post id (as X's own embed code computes it). Pure. */
function embedToken(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

function unescape(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

/** X's embed data -> {author, text, url, likes, replies, from}, or null when it isn't a post. Pure. */
function fromEmbed(d) {
  if (!d || !d.id_str) return null;
  const who = String(((d.user) || {}).screen_name || '');
  return { author: who, text: unescape(d.text).slice(0, 1200), url: `https://x.com/${who || 'i'}/status/${d.id_str}`,
    likes: Number(d.favorite_count) || 0, replies: Number(d.conversation_count) || 0, from: 'X embed data' };
}

/** X posts by id: {id: {author, text, url, likes, replies, from}} for those X serves. Eight at a time. Never throws. */
async function lookup(ids) {
  const want = Array.from(new Set((ids || []).map(String).filter(id => /^\d{5,25}$/.test(id))));
  const out = {};
  let next = 0;
  const worker = async () => {
    while (next < want.length) {
      const id = want[next++];
      try {
        const resp = await fetch(`${EMBED}?id=${id}&lang=en&token=${embedToken(id)}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
        if (resp.status !== 200) continue;
        const post = fromEmbed(await resp.json());
        if (post && post.text) out[id] = post;
      } catch (e) { /* that post is left out */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, want.length) }, worker));
  return out;
}

module.exports = { lookup, fromEmbed, embedToken };
