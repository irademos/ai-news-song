// Lists a YouTube channel's recent videos (via the public RSS feed) and fetches
// their transcripts with youtubei.js, so videos can be read like articles.

const YOUTUBE_FEED_URL = 'https://www.youtube.com/feeds/videos.xml?channel_id=';

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
    if (host === 'youtu.be') return parsed.pathname.slice(1).split('/')[0] || null;
    if (host !== 'youtube.com') return null;
    if (parsed.searchParams.get('v')) return parsed.searchParams.get('v');
    const pathMatch = parsed.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/);
    return pathMatch ? pathMatch[1] : null;
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

// Primary path: the transcript panel YouTube shows under the video
async function transcriptFromPanel(info, lang) {
  let transcriptInfo = await info.getTranscript();
  const wanted = transcriptInfo.languages.find((l) => l.toLowerCase().startsWith(lang === 'es' ? 'espa' : lang));
  if (wanted && wanted !== transcriptInfo.selectedLanguage) {
    transcriptInfo = await transcriptInfo.selectLanguage(wanted);
  }
  const segments = transcriptInfo.transcript?.content?.body?.initial_segments || [];
  return segments.map((seg) => seg.snippet?.toString?.() || '').filter(Boolean);
}

// Fallback: download the caption track directly, preferring human captions over auto-generated
async function transcriptFromCaptionTrack(info, lang) {
  const tracks = info.captions?.caption_tracks || [];
  const matching = tracks.filter((t) => t.language_code?.startsWith(lang));
  const track = matching.find((t) => t.kind !== 'asr') || matching[0];
  if (!track) return [];

  const url = new URL(track.base_url);
  url.searchParams.set('fmt', 'json3');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Caption track status ${response.status}`);
  const data = await response.json();
  return (data.events || [])
    .map((event) => (event.segs || []).map((s) => s.utf8 || '').join(''))
    .map((text) => text.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
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

async function fetchYoutubeTranscript(url, { lang = 'es' } = {}) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Not a YouTube video URL.');

  const yt = await getInnertube();
  const info = await yt.getInfo(videoId);

  let segments = [];
  try {
    segments = await transcriptFromPanel(info, lang);
  } catch (err) {
    console.warn(`Transcript panel unavailable for ${videoId}:`, err.message);
  }
  if (!segments.length) {
    segments = await transcriptFromCaptionTrack(info, lang);
  }
  if (!segments.length) throw new Error('No transcript available for this video.');

  return segmentsToParagraphs(segments);
}

module.exports = { fetchChannelVideos, fetchYoutubeTranscript, isYoutubeUrl, extractVideoId, segmentsToParagraphs };
