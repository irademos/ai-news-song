const express = require('express');
const fs = require('fs');
const path = require('path');
const { fetchTopNews } = require('./newsService');

const SUNO_PROMPT_MAX_CHARS = 3000;
const OPEN_ROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const LYRIC_MODELS = [
  // Order matters: try fastest/cheapest first, then stronger fallbacks.
  'deepseek/deepseek-chat-v3.1:free',
  'meta-llama/llama-3.1-8b-instruct:free',
  'openai/gpt-4o-mini',
  'anthropic/claude-3.5-sonnet',
  'google/gemini-1.5-flash',
  'meta/llama-3.1-8b-instruct',
];
const OPENROUTER_HEADERS = {
  'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
  // OpenRouter recommends these two for routing/analytics; not strictly required but helps reliability:
  'HTTP-Referer': process.env.SITE_URL || 'http://localhost:3000',
  'X-Title': 'Daily Spin', //'ai-news-song'
  'Content-Type': 'application/json',
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function callOpenRouterOnce({ model, messages, timeoutMs = 20000 }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(OPEN_ROUTER_API_URL, {
      method: 'POST',
      headers: OPENROUTER_HEADERS,
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.85,
        max_tokens: 400,
      }),
      signal: ctrl.signal,
    });

    // Treat 5xx as retryable; 4xx as terminal for this model
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`OpenRouter ${res.status}: ${text || res.statusText}`);
      err.status = res.status;
      throw err;
    }

    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('OpenRouter did not return content');
    return content;
  } finally {
    clearTimeout(t);
  }
}

async function callOpenRouterWithRetries({ model, messages, attempts = 3 }) {
  let delay = 750;
  for (let i = 0; i < attempts; i++) {
    try {
      return await callOpenRouterOnce({ model, messages });
    } catch (err) {
      // 5xx/abort -> retry; 4xx -> stop
      const status = err.status || 0;
      const retryable = status >= 500 || status === 0; // 0 = fetch/abort/network
      if (!retryable || i === attempts - 1) throw err;
      await sleep(delay);
      delay *= 2; // backoff
    }
  }
}

function loadEnv() {
  const envFile = path.join(__dirname, '..', '.env');

  if (process.env.suno_api || !fs.existsSync(envFile)) {
    return;
  }

  try {
    const contents = fs.readFileSync(envFile, 'utf8');
    contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .forEach((line) => {
        const [key, ...rest] = line.split('=');
        if (!key || rest.length === 0) {
          return;
        }

        const value = rest.join('=').trim().replace(/^['"]|['"]$/g, '');

        if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
          process.env[key] = value;
        }
      });
  } catch (error) {
    console.warn('Unable to read .env file:', error.message);
  }
}

loadEnv();

const app = express();
app.use(express.json());

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'components', 'index.html'));
});

app.get('/api/firebase-config', (_req, res) => {
  const config = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    databaseURL: process.env.FIREBASE_DATABASE_URL,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
  };

  if (!config.apiKey || !config.projectId) {
    return res.status(500).json({ error: 'Firebase configuration is missing.' });
  }

  res.json(config);
});

function enforcePromptLimit(text, max = SUNO_PROMPT_MAX_CHARS) {
  if (typeof text !== 'string') return '';
  const normalised = text.replace(/\s+$/g, '').trim();
  if (normalised.length <= max) {
    return normalised;
  }
  return `${normalised.slice(0, max - 1).trimEnd()}…`;
}

function formatStoriesForModel(stories) {
  return stories
    .map((story, index) => {
      const parts = [];
      const prefix = story?.source ? `[${story.source}]` : 'Headline';
      const headline = story?.headline ? story.headline : '';
      const summary = story?.summary ? `Summary: ${story.summary}` : '';
      parts.push(`${index + 1}. ${prefix} ${headline}`.trim());
      if (summary) parts.push(summary);
      return parts.filter(Boolean).join(' \u2014 ');
    })
    .filter(Boolean)
    .join('\n');
}

async function generateLyricsWithOpenRouter(stories) {
  const newsDigest = formatStoriesForModel(stories);
  const system = [
    'You are a news reporter writing literal, clear, factual lyrics about current events.',
    'Keep the response under 3000 characters. Do not include introductions or commentary—respond with lyrics only.',
  ].join(' ');
  const user = [
    `Use these headlines to craft a cohesive set of song lyrics.`,
    `Mention the concrete events and provide details. Prefer accurate clear description of the news.\n\n${newsDigest}`,
  ].join(' ');
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  const errors = [];
  for (const model of LYRIC_MODELS) {
    console.log("trying model:", model);
    try {
      const lyrics = await callOpenRouterWithRetries({ model, messages, attempts: 3 });
      console.log("lyrics:", lyrics, "test:", /\w/.test(lyrics));
      if (lyrics && /\w/.test(lyrics)) return enforcePromptLimit(lyrics);
    } catch (e) {
      console.log(model, e);
      errors.push(`[${model}] ${e.message}`);
      continue;
    }
  }

  // Last-resort stub so the Suno step can proceed
  const fallback = [
    `${newsDigest}`,
  ].join('\n');

  return enforcePromptLimit(fallback);
}

async function generateSongFromNews() {
  const createRes = await fetch('/api/generate-song', { method: 'POST' });
  if (createRes.status !== 202) {
    const err = await createRes.json().catch(() => ({}));
    throw new Error(err.error || 'Create failed');
  }

  const { clip_ids } = await createRes.json();
  const audio = await pollForAudio(clip_ids);
  return audio; // { clip_id, audio_url, ... }
}

async function pollForAudio(clipIds, { timeoutMs = 120000, intervalMs = 2500 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const qs = encodeURIComponent(clipIds.join(','));
    const r = await fetch(`/api/song-status?clip_ids=${qs}`);
    const { data = [] } = await r.json();

    const ready = data.find(d => d.state === 'succeeded' && d.audio_url);
    if (ready) return ready;

    await new Promise(res => setTimeout(res, intervalMs));
  }
  throw new Error('Timed out waiting for Suno audio');
}


// POST /api/generate-song
app.post('/api/generate-song', async (_req, res) => {
  const sunoApiKey = process.env.suno_api || process.env.SUNO_API || process.env.SUNO_API_KEY;
  if (!sunoApiKey) return res.status(500).json({ error: 'Suno API key is not configured.' });

  if (!process.env.OPEN_ROUTER_KEY) {
    return res.status(500).json({ error: 'OpenRouter API key is not configured.' });
  }

  const stories = await fetchTopNews(5);
  if (!stories.length) return res.status(503).json({ error: 'No news headlines are available right now.' });

  let lyrics;
  try {
    lyrics = await generateLyricsWithOpenRouter(stories);
  } catch (error) {
    console.error('Unable to create lyrics with OpenRouter:', error);
    return res.status(502).json({ error: 'Unable to create lyrics from OpenRouter.', details: error.message });
  }

  const prompt = lyrics;
  console.log('Suno prompt (lyrics):', prompt);

  const resp = await fetch('https://api.sunoapi.com/api/v1/suno/create', {
    method: 'POST',
    headers: { Authorization: `Bearer ${sunoApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      custom_mode: true,
      prompt: prompt,
      make_instrumental: false,
      mv: 'chirp-v5',
    }),
  });

  const raw = await resp.text();
  if (!resp.ok) {
    let details; try { details = JSON.parse(raw); } catch { details = raw; }
    return res.status(resp.status).json({ error: 'Suno create failed', details, promptLen: prompt.length });
  }

  let data; try { data = JSON.parse(raw); } catch { data = raw; }

  // Normalize IDs from various possible shapes
  const toArray = (v) => (Array.isArray(v) ? v : (v ? [v] : []));
  const list = Array.isArray(data?.data) ? data.data : toArray(data);

  const taskIds = [];
  const clipIds = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (item.task_id) taskIds.push(item.task_id);
    if (item.id && !item.clip_id && !item.song_id) taskIds.push(item.id); // some payloads use "id" for task
    if (item.clip_id) clipIds.push(item.clip_id);
    if (item.song_id) clipIds.push(item.song_id); // sometimes named differently
  }

  // If we got nothing, return the raw body to debug quickly
  if (!taskIds.length && !clipIds.length) {
    return res.status(202).json({ task_ids: [], clip_ids: [], raw: data, prompt });
  }

  return res.status(202).json({ task_ids: [...new Set(taskIds)], clip_ids: [...new Set(clipIds)], prompt });
});


function parseIds(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => (typeof entry === 'string' ? entry.split(',') : []))
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  if (typeof value !== 'string') return [];

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeStatusPayload(body) {
  if (!body) return { data: [] };

  if (Array.isArray(body?.data)) {
    return { data: body.data };
  }

  if (Array.isArray(body)) {
    return { data: body };
  }

  const combined = [];
  if (Array.isArray(body?.clips)) combined.push(...body.clips);
  if (Array.isArray(body?.tasks)) combined.push(...body.tasks);

  if (combined.length === 0 && typeof body === 'object') {
    combined.push(body);
  }

  return { data: combined };
}

app.get('/api/song-status', async (req, res) => {
  const apiKey = process.env.suno_api || process.env.SUNO_API || process.env.SUNO_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Suno API key is not configured.' });

  const taskIds = parseIds(req.query.task_ids || req.query.ids);
  const clipIds = parseIds(req.query.clip_ids);

  if (!taskIds.length && !clipIds.length) {
    return res.status(400).json({ error: 'You must provide task_ids or clip_ids.' });
  }

  try {
    let rows = [];

    if (taskIds.length) {
      // Poll the documented endpoint per task id
      const results = await Promise.all(taskIds.map(async (id) => {
        const r = await fetch(`https://api.sunoapi.com/api/v1/suno/task/${encodeURIComponent(id)}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        const raw = await r.text();
        let j; try { j = JSON.parse(raw); } catch { j = raw; }
        if (!r.ok) throw new Error(typeof j === 'object' ? JSON.stringify(j) : String(j));
        return Array.isArray(j?.data) ? j.data : [];
      }));
      rows = results.flat();
    } else {
      // Fallback: list recent tasks, then filter by clip_ids
      const r = await fetch('https://api.sunoapi.com/api/v1/suno/task/', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const raw = await r.text();
      let j; try { j = JSON.parse(raw); } catch { j = raw; }
      if (!r.ok) return res.status(r.status).json({ error: 'Suno task fetch failed', details: j });
      rows = Array.isArray(j?.data) ? j.data : [];
      if (clipIds.length) rows = rows.filter(x => clipIds.includes(x.clip_id));
    }

    return res.json({
      code: 200,
      data: rows.map(r => ({
        clip_id: r.clip_id,
        state: r.state,
        title: r.title,
        tags: r.tags,
        lyrics: r.lyrics,
        image_url: r.image_url,
        audio_url: r.audio_url,
        video_url: r.video_url,
        created_at: r.created_at,
        mv: r.mv,
        duration: r.duration,
      })),
      message: 'success',
    });
  } catch (error) {
    return res.status(502).json({ error: 'Suno task lookup failed', details: String(error?.message || error) });
  }
});





const port = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Daily Spin server listening on port ${port}`);
    fetchTopNews()
      .then((stories) => {
        if (!stories.length) {
          console.log('No fresh news stories were retrieved.');
          return;
        }

        console.log("Today's headlines:");
        stories.forEach((story, index) => {
          console.log(`\n${index + 1}. ${story.headline}`);
          if (story.summary) {
            console.log(`   Summary: ${story.summary}`);
          }
        });
      })
      .catch((error) => {
        console.error('Unexpected error while logging news stories:', error);
      });
  });
}

module.exports = app;
