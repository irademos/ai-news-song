// Spanish podcasts that publish full episode transcripts on their (WordPress) sites. Stories
// link to the transcript pages, whose text is read by the regular article extractor.
// WordPress exposes feeds at several paths depending on how posts are organised, so each
// source lists candidate feeds and the first one that returns items wins.
const SPANISH_PODCAST_SOURCES = [
  {
    source: 'Radio Ambulante',
    lang: 'es',
    feeds: [
      'https://radioambulante.org/category/transcripcion/feed/',
      'https://radioambulante.org/transcripcion/feed/',
    ],
  },
  {
    source: 'El hilo',
    lang: 'es',
    feeds: [
      'https://elhilo.audio/podcast/feed/',
      'https://elhilo.audio/feed/',
    ],
  },
];

const FEED_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
};

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function extractTag(xml, tag) {
  const cdata = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i'));
  if (cdata) return cdata[1];
  const std = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return std ? decodeEntities(std[1]) : '';
}

function stripHtml(text) {
  return decodeEntities(text.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// WordPress appends "The post X appeared first on Y" / "La entrada X se publicó primero en Y".
function cleanExcerpt(text) {
  return text
    .replace(/\s*(The post|La entrada)\s.*?(appeared first on|se publicó primero en|apareció primero en)\s.*$/i, '')
    .replace(/\s*\[(…|&#8230;|\.\.\.)\]\s*$/, '…')
    .trim();
}

function parseFeed(xml, { source, lang }, limit) {
  const items = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while (items.length < limit && (match = itemPattern.exec(xml)) !== null) {
    const itemXml = match[1];
    const headline = stripHtml(extractTag(itemXml, 'title'));
    const link = stripHtml(extractTag(itemXml, 'link'));
    const summary = cleanExcerpt(stripHtml(extractTag(itemXml, 'description')));
    const published = Date.parse(extractTag(itemXml, 'pubDate'));
    if (headline && link) {
      items.push({
        headline,
        summary,
        link,
        source,
        lang,
        published_at: Number.isFinite(published) ? published : undefined,
      });
    }
  }
  return items;
}

async function fetchPodcastStories(entry, limit = 20) {
  for (const feedUrl of entry.feeds) {
    try {
      const response = await fetch(feedUrl, { headers: FEED_HEADERS });
      if (!response.ok) throw new Error(`Status ${response.status}`);
      const items = parseFeed(await response.text(), entry, limit);
      if (items.length) return items;
    } catch (err) {
      console.warn(`Unable to fetch ${entry.source} feed ${feedUrl}:`, err.message);
    }
  }
  console.error(`No usable feed found for ${entry.source}.`);
  return [];
}

module.exports = {
  SPANISH_PODCAST_SOURCES,
  fetchPodcastStories,
};
