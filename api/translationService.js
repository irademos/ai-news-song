const { fbGet, fbSet, sanitizePath } = require('./firebaseService');
const { queryMyMemory } = require('./myMemoryClient');
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function storyCacheKey(story) {
  // Key by URL when available, otherwise by headline
  const raw = story.link || story.headline || '';
  return `translations/stories/${sanitizePath(raw)}`;
}

function splitIntoSentences(text) {
  // Split on sentence-ending punctuation followed by whitespace or end-of-string
  const parts = text.match(/[^.!?…]+(?:[.!?…]+(?:\s|$)|$)/g) || [];
  const sentences = parts.map((s) => s.trim()).filter(Boolean);
  return sentences.length ? sentences : [text.trim()];
}

function sentenceCacheKey(sentence, from, to) {
  // Use a normalized slice of the sentence as the key to stay stable across minor whitespace changes
  const normalized = sentence.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 180);
  return `translations/sentences/${from}-${to}/${sanitizePath(normalized)}`;
}

async function translateArticleBySentence(articleText, { from = 'en', to = 'es' } = {}) {
  // Split paragraphs, then sentences within each paragraph
  const paragraphs = articleText.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const allSentences = paragraphs.flatMap((para) => splitIntoSentences(para));

  const results = [];
  for (const sentence of allSentences) {
    if (!sentence) continue;
    const key = sentenceCacheKey(sentence, from, to);
    const cached = await fbGet(key);
    if (cached && cached.translated && cached.cached_at && Date.now() - cached.cached_at < CACHE_TTL_MS) {
      results.push({ original: sentence, translated: cached.translated });
      continue;
    }
    const translated = await tryTranslate(sentence, { from, to });
    if (translated) {
      fbSet(key, { translated, cached_at: Date.now() }).catch(() => {});
    }
    results.push({ original: sentence, translated: translated ?? sentence });
  }
  return results;
}

// Returns the translation, or null if MyMemory failed (so callers can skip caching it)
async function tryTranslate(text, { from = 'en', to = 'es' } = {}) {
  if (!text || !text.trim()) return null;

  try {
    const json = await queryMyMemory(text.slice(0, 500), `${from}|${to}`);
    const translated = json?.responseData?.translatedText;
    if (translated && typeof translated === 'string' && translated.trim()) {
      return translated.trim();
    }
  } catch {
    // fall through
  }
  return null;
}

async function translateText(text, opts) {
  return (await tryTranslate(text, opts)) ?? text;
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
          tryTranslate(story.headline),
          story.summary ? tryTranslate(story.summary) : Promise.resolve(''),
        ]);

        // Cache in background, but only complete translations so failures get retried
        if (headline && (summary || !story.summary)) {
          fbSet(key, { headline, summary, cached_at: Date.now() }).catch(() => {});
        }

        return {
          ...story,
          headline: headline ?? story.headline,
          summary: summary ?? story.summary ?? '',
          translated: true,
        };
      }),
    );
    results.push(...translated);
  }
  return results;
}

module.exports = { translateText, translateStories, translateArticleBySentence, splitIntoSentences };
