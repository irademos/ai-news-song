const { fbGet, fbSet, sanitizePath } = require('./firebaseService');

const MYMEMORY_URL = 'https://api.mymemory.translated.net/get';

// Simple Spanish lemmatizer — maps inflected forms to a base form for cache keying.
// Not exhaustive but covers the most common noun plural and adjective agreement endings.
function getLemma(word) {
  const w = word.toLowerCase().normalize('NFC');
  if (w.length <= 3) return w;

  // Noun/adj plurals ending in vowel+s → remove -s  (casas→casa, libros→libro)
  if (/[aeiouáéíóú]s$/.test(w)) return w.slice(0, -1);

  // Noun/adj plurals ending in consonant+es → remove -es  (camiones→camion)
  if (w.length > 4 && /[^aeiouáéíóú]es$/.test(w)) return w.slice(0, -2);

  return w;
}

function cacheKey(word) {
  return sanitizePath(getLemma(word));
}

async function lookupWord(word) {
  if (!word || word.trim().length < 2) return [];

  const key = cacheKey(word.trim());

  const cached = await fbGet(`translations/words/${key}`);
  if (cached && Array.isArray(cached.meanings) && cached.meanings.length) {
    return cached.meanings;
  }

  try {
    const lemma = getLemma(word.trim().toLowerCase());
    const url = `${MYMEMORY_URL}?q=${encodeURIComponent(lemma)}&langpair=es|en`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Daily-Spin/1.0' } });
    if (!res.ok) return [];
    const json = await res.json();

    const seen = new Set();
    const meanings = [];

    function add(t) {
      if (!t || typeof t !== 'string') return;
      const clean = t.trim().toLowerCase();
      if (!clean || clean.length > 80 || seen.has(clean)) return;
      // Skip if result is same as input (untranslated)
      if (clean === lemma) return;
      seen.add(clean);
      meanings.push(clean);
    }

    add(json?.responseData?.translatedText);
    if (Array.isArray(json?.matches)) {
      for (const m of json.matches) add(m?.translation);
    }

    const result = meanings.slice(0, 8);

    if (result.length) {
      fbSet(`translations/words/${key}`, {
        word: lemma,
        meanings: result,
        cached_at: Date.now(),
      }).catch(() => {});
    }

    return result;
  } catch {
    return [];
  }
}

module.exports = { lookupWord, getLemma };
