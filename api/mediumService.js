const { extractTextFromHtml } = require('./articleService');

// Medium publishes an RSS feed per author at https://medium.com/feed/@handle whose items carry
// the full post HTML in <content:encoded>. Medium article pages tend to block server-side
// scraping, so both headlines and article text are read from the feed.
const SPANISH_MEDIUM_CHANNELS = [
  { handle: 'ajplusespanol', source: 'AJ+ Español', lang: 'es' },
];

const FEED_HEADERS = {
  'User-Agent': 'Daily-Spin/1.0 (+https://example.com)',
  Accept: 'application/rss+xml, application/xml',
};

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function extractTag(xml, tag) {
  const cdata = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i'));
  if (cdata) return cdata[1];
  const std = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return std ? decodeEntities(std[1]) : '';
}

function stripHtml(text) {
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Drops Medium's ?source=rss-... tracking query so links are stable cache keys.
function cleanMediumLink(link) {
  try {
    const url = new URL(link.trim());
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return link.trim();
  }
}

function isMediumUrl(value) {
  try {
    const { hostname } = new URL(value);
    return hostname === 'medium.com' || hostname.endsWith('.medium.com');
  } catch {
    return false;
  }
}

function summarize(text, maxLength = 300) {
  const first = text.split('\n\n')[0] || '';
  return first.length > maxLength ? `${first.slice(0, maxLength).replace(/\s+\S*$/, '')}…` : first;
}

async function fetchMediumFeedItems(handle) {
  const response = await fetch(`https://medium.com/feed/@${handle}`, { headers: FEED_HEADERS });
  if (!response.ok) throw new Error(`Status ${response.status}`);
  const xml = await response.text();

  const items = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemPattern.exec(xml)) !== null) {
    const itemXml = match[1];
    const headline = stripHtml(decodeEntities(extractTag(itemXml, 'title')));
    const link = cleanMediumLink(extractTag(itemXml, 'link'));
    const content = extractTextFromHtml(extractTag(itemXml, 'content:encoded') || extractTag(itemXml, 'description'));
    const published = Date.parse(extractTag(itemXml, 'pubDate'));
    if (headline && link) {
      items.push({ headline, link, content, published_at: Number.isFinite(published) ? published : undefined });
    }
  }
  return items;
}

async function fetchMediumStories({ handle, source, lang }, limit = 20) {
  try {
    const items = await fetchMediumFeedItems(handle);
    return items.slice(0, limit).map(({ headline, link, content, published_at }) => ({
      headline,
      summary: summarize(content),
      link,
      source,
      lang,
      published_at,
    }));
  } catch (err) {
    console.error(`Unable to fetch Medium feed @${handle}:`, err.message);
    return [];
  }
}

// Returns a Medium post's full text by locating it in its author's feed. Only recent posts
// (the feed's last ~10) are available this way.
async function fetchMediumArticle(url) {
  const handle = new URL(url).pathname.match(/^\/@([^/]+)/)?.[1];
  if (!handle) throw new Error('Medium URL does not include an author handle.');

  const target = cleanMediumLink(url);
  const items = await fetchMediumFeedItems(handle);
  const item = items.find((entry) => entry.link === target);
  if (!item || !item.content) throw new Error('Post not found in the author feed.');
  return item.content;
}

module.exports = {
  SPANISH_MEDIUM_CHANNELS,
  fetchMediumStories,
  fetchMediumArticle,
  isMediumUrl,
};
