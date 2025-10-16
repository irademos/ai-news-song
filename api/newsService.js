const https = require('https');

const NEWS_SOURCES = [
  {
    url: 'https://feeds.bbci.co.uk/news/rss.xml',
    source: 'BBC News',
  },
  {
    url: 'https://feeds.npr.org/1001/rss.xml',
    source: 'NPR',
  },
];

const DEFAULT_LIMIT = 5;

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractTagValue(xml, tagName) {
  const cdataPattern = new RegExp(`<${tagName}><!\\[CDATA\\[(.*?)\\]\\]><\\/${tagName}>`, 'i');
  const standardPattern = new RegExp(`<${tagName}>(.*?)<\\/${tagName}>`, 'i');

  const cdataMatch = xml.match(cdataPattern);
  if (cdataMatch) {
    return decodeEntities(cdataMatch[1]);
  }

  const standardMatch = xml.match(standardPattern);
  if (standardMatch) {
    return decodeEntities(standardMatch[1]);
  }

  return '';
}

function stripHtml(text) {
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseFeed(xml, limit) {
  const items = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/gi;
  let match;

  while (items.length < limit && (match = itemPattern.exec(xml)) !== null) {
    const itemXml = match[1];
    const headline = stripHtml(extractTagValue(itemXml, 'title'));
    const summary = stripHtml(extractTagValue(itemXml, 'description'));
    const link = extractTagValue(itemXml, 'link');

    if (headline) {
      items.push({ headline, summary, link });
    }
  }

  return items;
}

function fetchWithHttps(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, {
        headers: {
          'User-Agent': 'Daily-Spin/1.0 (+https://example.com)',
          Accept: 'application/rss+xml, application/xml',
        },
      })
      .on('response', (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          reject(new Error(`Request failed with status ${res.statusCode}`));
          return;
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      })
      .on('error', (error) => reject(error));
  });
}

function fetchXml(url) {
  if (typeof fetch === 'function') {
    return fetch(url, {
      headers: {
        'User-Agent': 'Daily-Spin/1.0 (+https://example.com)',
        Accept: 'application/rss+xml, application/xml',
      },
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }
        return response.text();
      })
      .catch((error) => {
        console.warn('Standard fetch failed, retrying with HTTPS module:', error.message);
        return fetchWithHttps(url);
      });
  }

  return fetchWithHttps(url);
}

async function fetchSourceStories({ url, source }, limit) {
  try {
    const xml = await fetchXml(url);
    return parseFeed(xml, limit).map((story) => ({ ...story, source }));
  } catch (error) {
    console.error(`Unable to retrieve latest news from ${source}:`, error.message);
    return [];
  }
}

async function fetchTopNews(limit = DEFAULT_LIMIT) {
  const results = await Promise.all(
    NEWS_SOURCES.map((entry) => fetchSourceStories(entry, limit)),
  );

  return results.flat();
}

module.exports = {
  fetchTopNews,
};
