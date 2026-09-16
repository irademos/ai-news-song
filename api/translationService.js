const MYMEMORY_URL = 'https://api.mymemory.translated.net/get';

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
        const [headline, summary] = await Promise.all([
          translateText(story.headline),
          story.summary ? translateText(story.summary) : Promise.resolve(''),
        ]);
        return { ...story, headline, summary, translated: true };
      }),
    );
    results.push(...translated);
  }
  return results;
}

module.exports = { translateText, translateStories };
