const express = require('express');
const fs = require('fs');
const path = require('path');
const { fetchTopNews } = require('./newsService');

const SUNO_PROMPT_MAX_CHARS = 397;
const OPEN_ROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPEN_ROUTER_MODEL = process.env.OPEN_ROUTER_MODEL || 'deepseek/deepseek-chat-v3.1:free'; // 'meta-llama/llama-3.1-8b-instruct:free';

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
  const apiKey = process.env.OPEN_ROUTER_KEY;
  if (!apiKey) {
    throw new Error('OpenRouter API key is not configured.');
  }

  const newsDigest = formatStoriesForModel(stories);
  const messages = [
    {
      role: 'system',
      content:
        'You are a news reporter writing literal, clear, factual lyrics about current events. Keep the response under 3000 characters. Do not include introductions or commentary—respond with lyrics only.',
    },
    {
      role: 'user',
      content: `Use these headlines from BBC News and NPR to craft a cohesive set of song lyrics. Mention the concrete events while keeping tone thoughtful, empathetic, and suitable for an alternative pop track.\n\n${newsDigest}`,
    },
  ];

  // const response = await fetch(OPEN_ROUTER_API_URL, {
  //   method: 'POST',
  //   headers: {
  //     Authorization: `Bearer ${apiKey}`,
  //     'Content-Type': 'application/json',
  //     'HTTP-Referer': 'https://daily-spin.local',
  //     'X-Title': 'Daily Spin',
  //   },
  //   body: JSON.stringify({
  //     model: OPEN_ROUTER_MODEL,
  //     messages,
  //     max_tokens: 300,
  //     temperature: 0.7,
  //   }),
  // });

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      "model": "deepseek/deepseek-chat-v3.1:free",
      messages
    })
  });

  const raw = await response.text();
  console.log(raw);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new Error(`OpenRouter returned non-JSON response: ${error.message || 'parse error'}`);
  }

  if (!response.ok) {
    const details = payload?.error?.message || payload?.error || raw;
    throw new Error(typeof details === 'string' ? details : 'OpenRouter lyric generation failed');
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw new Error('OpenRouter did not provide any lyrics.');
  }

  return enforcePromptLimit(content);
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
      custom_mode: false,
      gpt_description_prompt: prompt,
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
