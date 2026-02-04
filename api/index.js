const express = require('express');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { fetchTopNews } = require('./newsService');
const { fetchArticleContent } = require('./articleService');

const MIN_ARTICLE_CHAR_LENGTH = 2000;

const SUNO_PROMPT_MAX_CHARS = 3000;
const OPEN_ROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const LYRIC_MODELS = [
  // Order matters: try fastest/cheapest first, then stronger fallbacks.
  'openai/gpt-4o-mini',
  'anthropic/claude-3.5-sonnet',
  'google/gemini-1.5-flash',
  'meta/llama-3.1-8b-instruct',
  'deepseek/deepseek-chat-v3.1:free',
  'meta-llama/llama-3.1-8b-instruct:free',
];

const PODCAST_PLANNER_MODEL = 'openai/gpt-4o-mini';

const ALLOWED_AUDIO_HOSTS = new Set([
  'audiopipe.suno.ai',
  'cdn.suno.ai',
  'cdn1.suno.ai',
  'cdn2.suno.ai',
  'cdn3.suno.ai',
]);

const SUNO_AUDIO_HOST_MIGRATIONS = new Map([
  ['audiopipe.suno.ai', 'cdn1.suno.ai'],
]);

function normalizeSunoAudioUrl(value, { migrateHost = false } = {}) {
  if (typeof value !== 'string') return '';

  const trimmed = value.trim();
  if (!trimmed) return '';

  if (trimmed.startsWith('/')) return trimmed;

  try {
    const parsed = new URL(trimmed);
    const lowerHost = parsed.hostname.toLowerCase();

    if (migrateHost) {
      const migratedHost = SUNO_AUDIO_HOST_MIGRATIONS.get(lowerHost);
      if (migratedHost) {
        parsed.hostname = migratedHost;
      }
    }

    return parsed.toString();
  } catch {
    return trimmed;
  }
}

function isAllowedAudioHost(hostname) {
  if (!hostname) return false;
  const lower = hostname.toLowerCase();
  for (const allowed of ALLOWED_AUDIO_HOSTS) {
    if (lower === allowed || lower.endsWith(`.${allowed}`)) {
      return true;
    }
  }
  return false;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function callOpenRouterOnce({ model, messages, timeoutMs = 20000 }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(OPEN_ROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPEN_ROUTER_KEY}`,
        // OpenRouter recommends these two for routing/analytics; not strictly required but helps reliability:
        'HTTP-Referer': process.env.SITE_URL || 'http://localhost:3000',
        'X-Title': 'Daily Spin', //'ai-news-song'
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.85,
      }),
      signal: ctrl.signal,
    });

    // Treat 5xx as retryable; 4xx as terminal for this model
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`OpenRouter ${res.status}: ${text || res.statusText}`);
      err.status = res.status;
      console.log(err);
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

async function resolveArticleLength(link, cache) {
  if (!link) {
    return 0;
  }

  if (cache.has(link)) {
    return cache.get(link);
  }

  let length = 0;
  try {
    const content = await fetchArticleContent(link);
    length = typeof content === 'string' ? content.length : 0;
  } catch (error) {
    console.warn(`Skipping story due to article fetch failure (${link}):`, error.message);
    length = 0;
  }

  cache.set(link, length);
  return length;
}

app.get('/api/news-headlines', async (req, res) => {
  const limit = 120;//Math.max(1, Math.min(20, Number.parseInt(req.query.limit, 10) || 8));

  try {
    const stories = await fetchTopNews(limit);
    const seen = new Set();
    const uniqueStories = [];
    const articleLengthCache = new Map();

    for (const story of stories) {
      if (!story?.headline || !story?.link) continue;
      const key = story.link || `${story.source || 'source'}:${story.headline}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const length = await resolveArticleLength(story.link, articleLengthCache);
      if (length < MIN_ARTICLE_CHAR_LENGTH) {
        continue;
      }

      uniqueStories.push({
        headline: story.headline,
        summary: story.summary || '',
        source: story.source || '',
        link: story.link || '',
      });

      if (uniqueStories.length >= limit) break;
    }

    res.json({ stories: uniqueStories });
  } catch (error) {
    res.status(502).json({ error: 'Unable to load news headlines.', details: error.message });
  }
});

app.post('/api/article-content', async (req, res) => {
  const { url } = req.body || {};

  if (!url) {
    return res.status(400).json({ error: 'Article URL is required.' });
  }

  try {
    const content = await fetchArticleContent(url);
    if (!content) {
      return res.status(404).json({ error: 'The article did not contain readable content.' });
    }

    res.json({ content });
  } catch (error) {
    res
      .status(502)
      .json({ error: 'Unable to load article content for the selected headline.', details: error.message });
  }
});

function enforcePromptLimit(text, max = SUNO_PROMPT_MAX_CHARS) {
  if (typeof text !== 'string') return '';
  const normalised = text.replace(/\s+$/g, '').trim();
  if (normalised.length <= max) {
    return normalised;
  }
  return `${normalised.slice(0, max - 1).trimEnd()}…`;
}

function extractJsonFromString(raw) {
  if (!raw) return null;
  const cleaned = typeof raw === 'string' ? raw.trim() : '';
  if (!cleaned) return null;

  if (cleaned.startsWith('{') || cleaned.startsWith('[')) {
    try { return JSON.parse(cleaned); } catch { /* fall through */ }
  }

  const match = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (match && match[1]) {
    try { return JSON.parse(match[1]); } catch { /* fall through */ }
  }

  return null;
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

function normalizeHeadlineKey(text) {
  if (!text) return '';
  return text
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function summarizeArticleWithOpenRouter({ headline, source, articleText }) {
  const apiKey = process.env.OPEN_ROUTER_KEY;
  console.log("getting lyrics for ", headline, source);
  if (!apiKey) {
    throw new Error('OpenRouter API key is not configured.');
  }

  if (!articleText) {
    throw new Error('No article content was provided for summarisation.');
  }

  const truncatedArticle = articleText.length > 20000 ? `${articleText.slice(0, 20000)}…` : articleText;
  const system = [
    'You are a songwriter who transforms news articles into factual, clear, and comprehensive songs.',
    'Your goal is to accurately convey the main points, background, context, and implications of the article as directly and clearly as possible.',
    'Prioritize clarity and completeness over artistic style.',
    'The song should explain events, causes, people involved, timelines, and consequences in a way that someone unfamiliar with the topic could fully understand.',
    'Use plain, direct language—avoid rhyme, metaphor, symbolism, or exaggeration unless absolutely necessary for readability.',
    'Maintain a neutral, explanatory, and informative tone, similar to a well-written summary that happens to have rhythm and phrasing like a song.',
    'Organize the lyrics logically (intro, body, conclusion), showing cause and effect where relevant.',
    'Prefer factual density—include as many specific details from the article as possible while keeping natural flow.',
    'The final output should be close to 3000 characters, but must not exceed that limit.',
    'Do not invent or infer facts not clearly stated in the article. Respond with plain text only.',
  ].join(' ');

  const user = [
    'Write a factual, explanatory song based on the following news article.',
    'Keep it clear, informative, and comprehensive, following the above rules.',
    `\n\nHeadline: ${headline || 'Unknown headline'}\nSource: ${source || 'Unknown source'}\n\nArticle Content:\n${truncatedArticle}`,
  ].join(' ');

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  const errors = [];
  let response = "";
  for (const model of LYRIC_MODELS) {
    console.log("trying model:", model);
    try {
      response = await callOpenRouterWithRetries({ model, messages, attempts: 1 });
      break;
    } catch (e) {
      errors.push(`[${model}] ${e.message}`);
      continue;
    }
  }

  if (!response) {
    throw new Error('no response from openrouter');
  }
  console.log("get lyrics success.")

  return enforcePromptLimit(response, SUNO_PROMPT_MAX_CHARS);
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
      const lyrics = await callOpenRouterWithRetries({ model, messages, attempts: 1 });
      if (lyrics && /\w/.test(lyrics)) return enforcePromptLimit(lyrics);
    } catch (e) {
      errors.push(`[${model}] ${e.message}`);
      continue;
    }
  }

  // Last-resort stub so the Suno step can proceed
  const fallback = [
    `${newsDigest}`,
  ].join('\n');

  console.log("get lyrics success")
  return enforcePromptLimit(fallback);
}

function scoreSimilarity(a, b) {
  const ta = new Set(a.split(/\s+/));
  const tb = new Set(b.split(/\s+/));

  let overlap = 0;
  for (const w of ta) if (tb.has(w)) overlap++;

  const maxLen = Math.max(ta.size, tb.size) || 1;
  return overlap / maxLen;  // 0–1
}

async function planPodcastWithOpenRouter(stories) {
  if (!stories?.length) throw new Error('At least one story is required to plan a podcast.');
  console.log("getting podcast plan");
  const digest = formatStoriesForModel(stories);
  const system = [
    'You are a podcast host crafting an energetic but concise script about the news.',
    'Pick exactly three distinct headlines from the provided list to explore in-depth.',
    'Write a short overview script that mentions the breadth of headlines before you dive deeper.',
    'For each chosen headline, propose a tight, spoken-word script (no narration notes, no stage directions).',
    'Keep everything friendly, vivid, and under 1200 words total. Return pure JSON.',
  ].join(' ');

  const user = [
    'Create a JSON object describing a podcast episode with these keys:',
    'overview_script: spoken narration that tees up the whole news set.',
    'selections: array of exactly three objects with {headline, source, reason, host_script}.',
    'Each selected headline must appear exactly as given. host_script should be 100-200 words.',
    'Make sure overview_script is 160-260 words and references multiple headlines.',
    '',
    'Headlines:',
    digest,
  ].join('\n');

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  for (const model of LYRIC_MODELS) {
    console.log("trying model:", model);
    try {
      raw = await callOpenRouterWithRetries({ model, messages, attempts: 1 });
      break;
    } catch (e) {
      // errors.push(`[${model}] ${e.message}`);
      continue;
    }
  }
  const parsed = extractJsonFromString(raw);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Podcast planner did not return JSON.');
  }

  const overviewScript = typeof parsed.overview_script === 'string'
    ? parsed.overview_script.trim()
    : '';

  const selections = Array.isArray(parsed.selections) ? parsed.selections : [];
  const normalized = selections
    .map((entry) => {
      const headline = typeof entry?.headline === 'string' ? entry.headline.trim() : '';
      if (!headline) return null;
      return {
        headline,
        source: typeof entry?.source === 'string' ? entry.source.trim() : '',
        reason: typeof entry?.reason === 'string' ? entry.reason.trim() : '',
        host_script: typeof entry?.host_script === 'string' ? entry.host_script.trim() : '',
      };
    })
    .filter(Boolean)
    .slice(0, 3);

  const storyKeyMap = new Map(stories.map((story) => [
    normalizeHeadlineKey(story.headline),
    story.headline
  ]));

  const filtered = normalized
    .map((sel) => {
      const key = normalizeHeadlineKey(sel.headline);

      let best = null;
      let bestScore = 0;

      for (const story of stories) {
        const storyKey = normalizeHeadlineKey(story.headline);
        const score = scoreSimilarity(key, storyKey);
        if (score > bestScore) {
          bestScore = score;
          best = story;
        }
      }

      const THRESHOLD = 0.35;
      return bestScore >= THRESHOLD
        ? { ...sel, headline: best.headline }
        : null;
    })
    .filter(Boolean);


  if (!overviewScript || filtered.length !== 3) {
    throw new Error('Podcast planner returned an incomplete plan.');
  }

  return { overviewScript, selections: filtered };
}

async function writeDeepDiveScript({ headline, source, articleText }) {
  console.log("getting deep dive for", headline);
  if (!articleText) throw new Error('Full article text is required for a deep dive script.');

  const truncated = articleText.length > 16000 ? `${articleText.slice(0, 16000)}…` : articleText;
  const system = [
    'Write an engaging, conversational script that summarizes the full article for listeners.',
    'Keep it punchy, spoken aloud ready, 130-230 words, no bullet lists, no stage directions.',
  ].join(' ');

  const user = [
    `Headline: ${headline || 'Unknown headline'}`,
    source ? `Source: ${source}` : '',
    '',
    'Full article content:',
    truncated,
  ].filter(Boolean).join('\n');

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  const raw = await callOpenRouterWithRetries({ model: PODCAST_PLANNER_MODEL, messages, attempts: 1 });
  return enforcePromptLimit(raw);
}

async function createSunoTaskFromScript({ articleTxt, headline, source, tags }) {
  console.log("getting suno song for", headline);
  let lyrics;
  try {
    lyrics = await summarizeArticleWithOpenRouter({
      headline,
      source,
      articleText: articleTxt,
    });
  } catch (error) {
    console.error('Unable to summarise article with OpenRouter:', error);
    return null;
  }

  const sunoApiKey = process.env.suno_api || process.env.SUNO_API || process.env.SUNO_API_KEY;
  if (!sunoApiKey) throw new Error('Suno API key is not configured.');

  const sunoPayload = {
    custom_mode: true,
    prompt: lyrics,
    make_instrumental: false,
    mv: 'chirp-v5',
  };

  if (tags) sunoPayload.tags = tags;

  const resp = await fetch('https://api.sunoapi.com/api/v1/suno/create', {
    method: 'POST',
    headers: { Authorization: `Bearer ${sunoApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(sunoPayload),
  });

  const raw = await resp.text();
  if (!resp.ok) {
    let details; try { details = JSON.parse(raw); } catch { details = raw; }
    const err = new Error('Suno create failed');
    err.details = details;
    throw err;
  }

  let data; try { data = JSON.parse(raw); } catch { data = raw; }
  const toArray = (v) => (Array.isArray(v) ? v : (v ? [v] : []));
  const list = Array.isArray(data?.data) ? data.data : toArray(data);

  const taskIds = [];
  const clipIds = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (item.task_id) taskIds.push(item.task_id);
    if (item.id && !item.clip_id && !item.song_id) taskIds.push(item.id);
    if (item.clip_id) clipIds.push(item.clip_id);
    if (item.song_id) clipIds.push(item.song_id);
  }

  return { taskIds: [...new Set(taskIds)], clipIds: [...new Set(clipIds)] };
}

// POST /api/generate-song
app.post('/api/generate-song', async (req, res) => {
  const sunoApiKey = process.env.suno_api || process.env.SUNO_API || process.env.SUNO_API_KEY;
  if (!sunoApiKey) return res.status(500).json({ error: 'Suno API key is not configured.' });

  if (!process.env.OPEN_ROUTER_KEY) {
    return res.status(500).json({ error: 'OpenRouter API key is not configured.' });
  }

  const { url, headline, source, tags } = req.body || {};

  const normalizedTags = typeof tags === 'string'
    ? tags
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .join(', ')
    : '';

  let preparedLyrics = '';

  if (url) {
    let articleText;
    try {
      articleText = await fetchArticleContent(url);
    } catch (error) {
      console.error('Unable to fetch full article content:', error);
      return res.status(502).json({ error: 'Unable to retrieve the full article for the selected headline.', details: error.message });
    }

    try {
      preparedLyrics = await summarizeArticleWithOpenRouter({ headline, source, articleText });
    } catch (error) {
      console.error('Unable to summarise article with OpenRouter:', error);
      return res.status(502).json({ error: 'Unable to summarise the article with OpenRouter.', details: error.message });
    }
  } else {
    const stories = await fetchTopNews(5);
    if (!stories.length) return res.status(503).json({ error: 'No news headlines are available right now.' });

    try {
      preparedLyrics = await generateLyricsWithOpenRouter(stories);
    } catch (error) {
      console.error('Unable to create lyrics with OpenRouter:', error);
      return res.status(502).json({ error: 'Unable to create lyrics from OpenRouter.', details: error.message });
    }
  }

  const prompt = enforcePromptLimit(preparedLyrics);

  const sunoPayload = {
    custom_mode: true,
    prompt: prompt,
    make_instrumental: false,
    mv: 'chirp-v5',
  };

  if (normalizedTags) {
    sunoPayload.tags = normalizedTags;
  }

  const resp = await fetch('https://api.sunoapi.com/api/v1/suno/create', {
    method: 'POST',
    headers: { Authorization: `Bearer ${sunoApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(sunoPayload),
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
    return res.status(202).json({ task_ids: [], clip_ids: [], raw: data, prompt, summary: prompt, tags: normalizedTags });
  }

  return res.status(202).json({ task_ids: [...new Set(taskIds)], clip_ids: [...new Set(clipIds)], prompt, summary: prompt, tags: normalizedTags });
});

// POST /api/generate-podcast
app.post('/api/generate-podcast', async (req, res) => {
  if (!process.env.OPEN_ROUTER_KEY) {
    return res.status(500).json({ error: 'OpenRouter API key is not configured.' });
  }

  const stories = Array.isArray(req.body?.stories) ? req.body.stories : [];
  if (!stories.length) {
    return res.status(400).json({ error: 'At least one headline is required to build a podcast.' });
  }

  const phase = (req.query.phase || 'full').toLowerCase(); // 'plan' | 'full'
  const tags = typeof req.body?.tags === 'string' ? req.body.tags.trim() : '';

  try {
    const plan = await planPodcastWithOpenRouter(stories);

    const storyLookup = new Map(stories.map((s) => [normalizeHeadlineKey(s.headline), s]));
    const selectedStories = plan.selections.map((sel) => {
      const key = normalizeHeadlineKey(sel.headline);
      const match =
        storyLookup.get(key) ||
        stories.find((s) => normalizeHeadlineKey(s.headline) === key) ||
        {};
      return {
        ...match,
        headline: match.headline || sel.headline,
        source: sel.source || match.source || '',
        reason: sel.reason || '',
        host_script: sel.host_script || '',
      };
    });

    // 🔹 FAST PHASE: send overview + host scripts only, no deep dives, no Suno tasks
    if (phase === 'plan') {
      console.log("fast phase");
      const selections = selectedStories.map((story) => ({
        headline: story.headline,
        source: story.source || '',
        summary: story.summary || '',
        link: story.link || '',
        reason: story.reason || '',
        overviewScript: story.host_script || '',
        // we’ll upgrade this later when full generation finishes
        deepDiveScript: story.host_script || '',
        articleContent: '',
        songPrompt: '',
        songTaskIds: [],
        songClipIds: [],
        tags,
      }));

      return res.json({
        overviewScript: plan.overviewScript,
        selections,
        createdAtIso: new Date().toISOString(),
      });
    }

    // 🔹 FULL PHASE: existing heavy logic (deep dives + Suno)
    console.log("full phase");
    const deepDiveScripts = [];
    for (const story of selectedStories) {
      let articleText = '';
      try {
        articleText = await fetchArticleContent(story.link);
      } catch (error) {
        console.warn('Unable to fetch article for podcast deep dive:', error.message);
      }

      const deepScript = articleText
        ? await writeDeepDiveScript({ headline: story.headline, source: story.source, articleText })
        : story.host_script;

      deepDiveScripts.push({
        headline: story.headline,
        script: deepScript,
        articleContent: articleText,
        source: story.source,
      });
    }

    const selections = [];

    for (const story of selectedStories) {
      const deep = deepDiveScripts.find((entry) => entry.headline === story.headline) || {};
      const prompt = [
        'Create a short, melodic track inspired by this news story for a podcast music bed.',
        'Keep it modern and catchy. Lyrics should echo key details and stay under 900 characters.',
        deep.script || story.host_script,
      ]
        .filter(Boolean)
        .join('\n\n');

      const articleTxt = deep.articleContent;
      const hdline = deep.headline;
      const src = deep.source;

      const tasks = await createSunoTaskFromScript({
        articleTxt,
        headline: hdline,
        source: src,
        tags,
      });

      if (tasks) {
        selections.push({
          headline: story.headline,
          source: story.source || '',
          summary: story.summary || '',
          link: story.link || '',
          reason: story.reason || '',
          overviewScript: story.host_script || '',
          deepDiveScript: deep.script || story.host_script || '',
          articleContent: deep.articleContent || '',
          songPrompt: prompt,
          songTaskIds: tasks.taskIds || [],
          songClipIds: tasks.clipIds || [],
          tags,
        });
      }
    }

    res.json({
      overviewScript: plan.overviewScript,
      selections,
      createdAtIso: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Podcast generation failed:', error);
    res
      .status(502)
      .json({ error: 'Unable to generate podcast.', details: error.message });
  }
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

        if (r.ok) {
          return { id, ok: true, data: Array.isArray(j?.data) ? j.data : [] };
        }

        const details = typeof j === 'object' ? j : String(j);
        if ([401, 403].includes(r.status)) {
          return { id, ok: false, authError: true, status: r.status, details };
        }

        if ([400, 404, 422].includes(r.status)) {
          return { id, ok: false, pending: true, status: r.status, details };
        }

        return { id, ok: false, status: r.status, details };
      }));

      const authFailure = results.find((r) => r.authError);
      if (authFailure) {
        return res.status(authFailure.status).json({
          error: 'Suno authentication failed.',
          details: authFailure.details,
        });
      }

      const completedRows = results.flatMap((r) => (r.ok ? r.data : []));
      const pendingRows = results
        .filter((r) => !r.ok && r.pending)
        .map((r) => ({ task_id: r.id, state: 'pending' }));

      rows = [...completedRows, ...pendingRows];
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
        task_id: r.task_id,
        clip_id: r.clip_id,
        state: r.state,
        title: r.title,
        tags: r.tags,
        lyrics: r.lyrics,
        image_url: r.image_url,
        audio_url: normalizeSunoAudioUrl(r.audio_url),
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


app.get('/api/proxy-audio', async (req, res) => {
  const src = typeof req.query.src === 'string' ? req.query.src : '';

  if (!src) {
    return res.status(400).json({ error: 'A valid audio URL is required.' });
  }

  let url;
  try {
    url = new URL(src);
  } catch {
    return res.status(400).json({ error: 'Audio URL is invalid.' });
  }

  if (url.protocol !== 'https:') {
    return res.status(400).json({ error: 'Only HTTPS audio sources are supported.' });
  }

  if (!isAllowedAudioHost(url.hostname)) {
    return res.status(403).json({ error: 'Audio host is not permitted.' });
  }

  try {
    const upstream = await fetch(url, {
      headers: {
        'User-Agent': 'Daily-Spin/1.0',
      },
    });

    if (!upstream.ok || !upstream.body) {
      return res
        .status(upstream.status || 502)
        .json({ error: 'Unable to retrieve audio from source.' });
    }

    const contentType = upstream.headers.get('content-type') || 'audio/mpeg';
    const contentLength = upstream.headers.get('content-length');

    res.setHeader('Content-Type', contentType);
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }
    res.setHeader('Cache-Control', 'public, max-age=3600');

    Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) {
    res.status(502).json({ error: 'Audio proxy request failed.', details: String(error?.message || error) });
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
          // if (story.summary) {
          //   console.log(`   Summary: ${story.summary}`);
          // }
        });
      })
      .catch((error) => {
        console.error('Unexpected error while logging news stories:', error);
      });
  });
}

module.exports = app;
