const express = require('express');
const fs = require('fs');
const path = require('path');
const { fetchTopNews } = require('./newsService');

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

const songs = [
  {
    title: 'Neon Skyline',
    artist: 'Aurora Lane',
    date: '2024-04-22',
    isToday: true,
    streamUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
    description:
      'A shimmering synth-pop ode to city lights and long walks after midnight. Layered pads pulse beneath Aurora\'s hushed vocal, making this an easy repeat listen for winding down the day.',
  },
  {
    title: 'Golden Hour Coffee',
    artist: 'Sam Torres',
    date: '2024-04-21',
    isToday: false,
    streamUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3',
    description:
      'Acoustic guitar, brushed drums, and the gentle swirl of Sam\'s falsetto conjure the very best lazy Sunday morning vibes. Brew a cup and let this one warm the room.',
  },
  {
    title: 'Bloom Sequence',
    artist: 'Circuit Garden',
    date: '2024-04-20',
    isToday: false,
    streamUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3',
    description:
      'Modular pulses gradually unfold into a lush, cinematic crescendo. Circuit Garden blends organic field recordings with analog drift for a track that feels alive.',
  },
  {
    title: 'Skylark Avenue',
    artist: 'Indigo Knots',
    date: '2024-04-19',
    isToday: false,
    streamUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3',
    description:
      'A breezy slice of indie pop packed with chiming guitars and a chorus that sticks. Indigo Knots channel the excitement of the first warm day after a long winter.',
  },
];

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'components', 'index.html'));
});

app.get('/api/songs', (_req, res) => {
  res.json(songs);
});

function buildSongPrompt(stories) {
  const intro = "Write lyrics summarizing today's top news. Be specific about actual events.";
  const lines = stories.map(s => s.summary || s.headline);
  let prompt = `${intro} ${lines.join(' ')}`
                .replace(/\s+/g, ' ')
                .trim();

  // Suno non-custom mode limit ~400 chars. Leave a little headroom.
  const MAX = 600; //2980;
  if (prompt.length > MAX) {
    prompt = prompt.slice(0, MAX - 1) + '…';
  }
  return prompt;
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
  const apiKey = process.env.suno_api || process.env.SUNO_API || process.env.SUNO_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Suno API key is not configured.' });

  const stories = await fetchTopNews(5);
  if (!stories.length) return res.status(503).json({ error: 'No news headlines are available right now.' });

  const prompt = buildSongPrompt(stories);
  console.log(prompt);

  const resp = await fetch('https://api.sunoapi.com/api/v1/suno/create', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
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
