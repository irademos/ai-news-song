const MYMEMORY_URL = 'https://api.mymemory.translated.net/get';

// Queries MyMemory and returns the parsed JSON, or null when the request failed.
// MyMemory reports errors (including an exhausted daily quota) with HTTP 200 and the
// error message in translatedText, so the JSON status fields must be checked too.
async function queryMyMemory(q, langpair) {
  const params = new URLSearchParams({ q, langpair });
  // A contact email raises the free daily quota (anonymous use is limited per IP)
  const email = (process.env.MYMEMORY_EMAIL || '').trim();
  if (email) params.set('de', email);

  const res = await fetch(`${MYMEMORY_URL}?${params}`, {
    headers: { 'User-Agent': 'Daily-Spin/1.0' },
  });
  if (!res.ok) return null;
  const json = await res.json();

  const text = json?.responseData?.translatedText;
  if (
    Number(json?.responseStatus) !== 200 ||
    json?.quotaFinished ||
    (typeof text === 'string' && /^MYMEMORY WARNING/i.test(text))
  ) {
    console.warn(`MyMemory error (status ${json?.responseStatus}): ${String(text || json?.responseDetails || '').slice(0, 200)}`);
    return null;
  }
  return json;
}

module.exports = { queryMyMemory };
