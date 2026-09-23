// Keeps a permanent archive of the Spanish page's stories and videos in Firebase,
// bucketed by month (spanish_archive/<YYYY-MM>/<key>) so the archive can be browsed
// a month at a time without needing Firebase query indexes.

const crypto = require('crypto');
const { fbGet, fbPatch } = require('./firebaseService');

const ARCHIVE_PATH = 'spanish_archive';
const MONTH_PATTERN = /^\d{4}-\d{2}$/;

function archiveKey(link) {
  return crypto.createHash('sha1').update(link).digest('hex').slice(0, 16);
}

function monthOf(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 7);
}

// Saves stories that have a link and a publish date. Writes are idempotent (same key,
// same data), so re-archiving a story that is still in the feed is harmless.
async function archiveStories(stories) {
  const byMonth = new Map();
  stories.forEach((story) => {
    if (!story.link || !story.headline || !Number.isFinite(story.published_at)) return;
    const month = monthOf(story.published_at);
    if (!byMonth.has(month)) byMonth.set(month, {});
    byMonth.get(month)[archiveKey(story.link)] = {
      headline: story.headline,
      summary: story.summary || '',
      link: story.link,
      source: story.source || '',
      lang: story.lang || 'es',
      type: story.type || 'article',
      published_at: story.published_at,
    };
  });

  const results = await Promise.all(
    [...byMonth].map(([month, entries]) => fbPatch(`${ARCHIVE_PATH}/${month}`, entries)),
  );
  return results.every(Boolean);
}

// Months that have archived stories, newest first
async function listArchiveMonths() {
  const keys = await fbGet(ARCHIVE_PATH, { shallow: 'true' });
  return Object.keys(keys || {}).filter((m) => MONTH_PATTERN.test(m)).sort().reverse();
}

// A month's stories, newest first
async function getArchiveMonth(month) {
  if (!MONTH_PATTERN.test(month)) return [];
  const entries = await fbGet(`${ARCHIVE_PATH}/${month}`);
  return Object.values(entries || {}).sort((a, b) => (b.published_at || 0) - (a.published_at || 0));
}

module.exports = { archiveStories, listArchiveMonths, getArchiveMonth, MONTH_PATTERN };
