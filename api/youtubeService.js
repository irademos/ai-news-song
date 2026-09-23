// Lists a YouTube channel's recent videos (via the public RSS feed) and fetches
// their transcripts with youtubei.js, so videos can be read like articles.

const { fbGet, fbSet } = require('./firebaseService');

const YOUTUBE_FEED_URL = 'https://www.youtube.com/feeds/videos.xml?channel_id=';

const TRANSCRIPT_CACHE_PATH = 'youtube_transcripts';

// YouTube channels whose video transcripts are read like articles on the Spanish page
const SPANISH_YOUTUBE_CHANNELS = [
  { channelId: 'UCS0lmlVIYVz2qeWlZ_ynIWg', source: 'AJ+ Español', lang: 'es' },
];

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function extractTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeEntities(match[1]).trim() : '';
}

// Returns stories in the same shape as the RSS sources: { headline, summary, link, source, lang }
async function fetchChannelVideos({ channelId, source, lang = 'es', limit = 10 }) {
  try {
    const response = await fetch(`${YOUTUBE_FEED_URL}${channelId}`, {
      headers: { 'User-Agent': 'Daily-Spin/1.0 (+https://example.com)', Accept: 'application/atom+xml, application/xml' },
    });
    if (!response.ok) throw new Error(`Status ${response.status}`);
    const xml = await response.text();

    const items = [];
    const entryPattern = /<entry>([\s\S]*?)<\/entry>/gi;
    let match;
    while (items.length < limit && (match = entryPattern.exec(xml)) !== null) {
      const entry = match[1];
      const videoId = extractTag(entry, 'yt:videoId');
      const headline = extractTag(entry, 'title');
      if (!videoId || !headline) continue;
      // Keep only the first paragraph of the description; the rest is usually links/hashtags
      const summary = extractTag(entry, 'media:description').split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
      items.push({
        headline,
        summary,
        link: `https://www.youtube.com/watch?v=${videoId}`,
        source,
        lang,
        type: 'video',
      });
    }
    return items;
  } catch (err) {
    console.error(`Unable to fetch YouTube channel ${source}:`, err.message);
    return [];
  }
}

function extractVideoId(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\.|^m\./, '');
    let id = null;
    if (host === 'youtu.be') id = parsed.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com') {
      id = parsed.searchParams.get('v') || (parsed.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/) || [])[1];
    }
    // Video ids are always 11 url-safe characters (also safe to use as a Firebase key)
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function isYoutubeUrl(url) {
  return Boolean(extractVideoId(url));
}

let innertubePromise = null;
function getInnertube() {
  if (!innertubePromise) {
    // youtubei.js is ESM-only, so load it with a dynamic import from this CommonJS module
    innertubePromise = import('youtubei.js')
      .then(({ Innertube }) => Innertube.create({ lang: 'es', location: 'US', retrieve_player: false }))
      .catch((err) => {
        innertubePromise = null;
        throw err;
      });
  }
  return innertubePromise;
}

// Clients to try, in order. Mobile clients' caption URLs work without the PO token
// that web caption URLs now require, and are blocked less often from server IPs.
const CAPTION_CLIENTS = ['ANDROID', 'IOS', 'WEB'];

// Picks the best caption track: human captions over auto-generated, in the wanted language
function pickCaptionTrack(info, lang) {
  const tracks = info.captions?.caption_tracks || [];
  const matching = tracks.filter((t) => t.language_code?.startsWith(lang));
  return matching.find((t) => t.kind !== 'asr') || matching[0] || null;
}

async function downloadCaptionTrack(track) {
  const url = new URL(track.base_url);
  url.searchParams.set('fmt', 'json3');
  const response = await fetch(url, { headers: { 'Accept-Language': 'es' } });
  if (!response.ok) throw new Error(`caption track status ${response.status}`);
  const body = await response.text();
  if (!body.trim()) throw new Error('caption track returned an empty body');
  const data = JSON.parse(body);
  return (data.events || [])
    .map((event) => (event.segs || []).map((s) => s.utf8 || '').join(''))
    .map((text) => text.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// Last resort: the transcript panel YouTube shows under the video on the web
async function transcriptFromPanel(yt, videoId, lang) {
  const info = await yt.getInfo(videoId);
  let transcriptInfo = await info.getTranscript();
  const wanted = transcriptInfo.languages.find((l) => l.toLowerCase().startsWith(lang === 'es' ? 'espa' : lang));
  if (wanted && wanted !== transcriptInfo.selectedLanguage) {
    transcriptInfo = await transcriptInfo.selectLanguage(wanted);
  }
  const segments = transcriptInfo.transcript?.content?.body?.initial_segments || [];
  return segments.map((seg) => seg.snippet?.toString?.() || '').filter(Boolean);
}

// Joins caption lines into readable paragraphs of roughly `target` characters,
// breaking after sentence-ending punctuation where possible.
function segmentsToParagraphs(segments, target = 450) {
  const text = segments.join(' ').replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  const sentences = text.match(/[^.!?…]+[.!?…]+["»”')]*\s*|[^.!?…]+$/g) || [text];

  const paragraphs = [];
  let current = '';
  sentences.forEach((sentence) => {
    current += sentence;
    if (current.length >= target) {
      paragraphs.push(current.trim());
      current = '';
    }
  });
  if (current.trim()) paragraphs.push(current.trim());
  return paragraphs.join('\n\n');
}

// Downloads a transcript straight from YouTube, trying each client in turn.
// Throws with every attempt's error so logs show whether YouTube blocked the request.
async function downloadYoutubeTranscript(videoId, { lang = 'es' } = {}) {
  const yt = await getInnertube();
  const errors = [];

  for (const client of CAPTION_CLIENTS) {
    try {
      const info = await yt.getBasicInfo(videoId, { client });
      const status = info.playability_status?.status;
      if (status && status !== 'OK') {
        throw new Error(`${status}: ${info.playability_status?.reason || 'unplayable'}`);
      }
      const track = pickCaptionTrack(info, lang);
      if (!track) throw new Error(`no "${lang}" caption track`);
      const segments = await downloadCaptionTrack(track);
      if (segments.length) return segmentsToParagraphs(segments);
      throw new Error('caption track had no text');
    } catch (err) {
      errors.push(`${client}: ${err.message}`);
    }
  }

  try {
    const segments = await transcriptFromPanel(yt, videoId, lang);
    if (segments.length) return segmentsToParagraphs(segments);
    errors.push('panel: no segments');
  } catch (err) {
    errors.push(`panel: ${err.message}`);
  }

  throw new Error(`No transcript for ${videoId} (${errors.join('; ')})`);
}

// Transcripts never change, so they are cached in Firebase without expiry. The cache can
// also be pre-filled from a machine YouTube doesn't block (see scripts/cache-youtube-transcripts.js).
async function fetchYoutubeTranscript(url, { lang = 'es' } = {}) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Not a YouTube video URL.');

  const key = `${TRANSCRIPT_CACHE_PATH}/${videoId}`;
  const cached = await fbGet(key);
  if (cached && cached.content) return cached.content;

  const content = await downloadYoutubeTranscript(videoId, { lang });
  await fbSet(key, { videoId, content, cached_at: Date.now() });
  return content;
}

module.exports = {
  SPANISH_YOUTUBE_CHANNELS,
  fetchChannelVideos,
  downloadYoutubeTranscript,
  fetchYoutubeTranscript,
  isYoutubeUrl,
  extractVideoId,
  segmentsToParagraphs,
};
