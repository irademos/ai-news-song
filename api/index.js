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
  const intro = "Write imaginative lyrics for a short song summarizing today's top news headlines. Keep the tone thoughtful but hopeful.";

  const formattedHeadlines = stories
    .map((story, index) => {
      const summaryPart = story.summary ? ` — ${story.summary}` : '';
      return `${index + 1}. ${story.headline}${summaryPart}`;
    })
    .join('\n');

  return `${intro}\n\nHeadlines:\n${formattedHeadlines}`;
}

app.post('/api/generate-song', async (_req, res) => {
  try {
    const apiKey = process.env.suno_api;

    if (!apiKey) {
      res.status(500).json({ error: 'Suno API key is not configured.' });
      return;
    }

    const stories = await fetchTopNews(5);

    if (!stories.length) {
      res.status(503).json({ error: 'No news headlines are available right now.' });
      return;
    }

    const prompt = buildSongPrompt(stories);

    const response = await fetch('https://api.sunoapi.com/api/v1/suno/create', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        custom_mode: false,
        gpt_description_prompt: prompt,
        make_instrumental: false,
        mv: 'chirp-v5',
      }),
    });

    const rawBody = await response.text();

    if (!response.ok) {
      res.status(response.status).json({ error: 'Suno API request failed.', details: rawBody });
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(rawBody);
    } catch (error) {
      parsed = rawBody;
    }

    res.json({ success: true, prompt, suno: parsed });
  } catch (error) {
    console.error('Unable to generate song with Suno API:', error);
    res.status(500).json({ error: 'Unable to generate song at this time.' });
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
