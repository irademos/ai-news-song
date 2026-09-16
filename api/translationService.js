const { fbGet, fbSet, sanitizePath } = require('./firebaseService');

const MYMEMORY_URL = 'https://api.mymemory.translated.net/get';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function storyCacheKey(story) {
  // Key by URL when available, otherwise by headline
  const raw = story.link || story.headline || '';
  return `translations/stories/${sanitizePath(raw)}`;
}

async function translateText(text, { from = 'en', to = 'es' } = {}) {
  if (!text || !text.trim()) return text;

  try {
    const url = `${MYMEMORY_URL}?q=${encodeURIComponent(text.slice(0, 500))}&langpair=${from}|${to}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Daily-Spin/1.0' },
    });
    if (!res.ok) return text;
    const json = await res.json();
    const translated = json?.responseData?.translatedText;
    if (translated && typeof translated === 'string' && translated.trim()) {
      return translated.trim();
    }
  } catch {
    // fall through to original
  }
  return text;
}

async function translateStories(stories, { batchSize = 5 } = {}) {
  const results = [];
  for (let i = 0; i < stories.length; i += batchSize) {
    const batch = stories.slice(i, i + batchSize);
    const translated = await Promise.all(
      batch.map(async (story) => {
        const key = storyCacheKey(story);
        const cached = await fbGet(key);
        if (
          cached &&
          cached.headline &&
          cached.cached_at &&
          Date.now() - cached.cached_at < CACHE_TTL_MS
        ) {
          return {
            ...story,
            headline: cached.headline,
            summary: cached.summary || story.summary || '',
            translated: true,
          };
        }

        const [headline, summary] = await Promise.all([
          translateText(story.headline),
          story.summary ? translateText(story.summary) : Promise.resolve(''),
        ]);

        // Cache in background
        fbSet(key, { headline, summary, cached_at: Date.now() }).catch(() => {});

        return { ...story, headline, summary, translated: true };
      }),
    );
    results.push(...translated);
  }
  return results;
}

module.exports = { translateText, translateStories };
