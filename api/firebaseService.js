const FIREBASE_DATABASE_URL = (process.env.FIREBASE_DATABASE_URL || '').replace(/\/$/, '');

function sanitizePath(str) {
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 120);
}

// `query` is an optional object of REST query params, e.g. { shallow: 'true' }
async function fbGet(path, query) {
  if (!FIREBASE_DATABASE_URL) return null;
  const qs = query ? `?${new URLSearchParams(query)}` : '';
  try {
    const res = await fetch(`${FIREBASE_DATABASE_URL}/${path}.json${qs}`, {
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function fbSet(path, data) {
  if (!FIREBASE_DATABASE_URL) return false;
  try {
    const res = await fetch(`${FIREBASE_DATABASE_URL}/${path}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return res.ok;
  } catch { return false; }
}

// Merges `data`'s keys into the node at `path`, leaving its other children untouched
async function fbPatch(path, data) {
  if (!FIREBASE_DATABASE_URL) return false;
  try {
    const res = await fetch(`${FIREBASE_DATABASE_URL}/${path}.json`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return res.ok;
  } catch { return false; }
}

module.exports = { fbGet, fbSet, fbPatch, sanitizePath };
