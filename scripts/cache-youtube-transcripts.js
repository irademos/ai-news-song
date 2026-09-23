#!/usr/bin/env node
// Pre-fills the Firebase transcript cache for the Spanish page's YouTube channels.
//
// YouTube often blocks transcript requests from cloud servers such as Vercel, but not from
// home connections. Run this from your own computer (e.g. on a schedule) and the site will
// serve the cached transcripts without ever calling YouTube itself:
//
//   npm run cache-transcripts                 # the channel's latest ~15 videos (RSS feed)
//   npm run cache-transcripts -- --all        # every video on the channel (slow; resumable)
//   npm run cache-transcripts -- --all --limit=200
//
// Every video it sees is also added to the site's archive (spanish_archive/<YYYY-MM>).
//
// FIREBASE_DATABASE_URL is read from the environment, or from the repo's .env file.
// On Windows, scripts/cache-transcripts.cmd wraps this for Task Scheduler.

const fs = require('fs');
const path = require('path');

// Load .env before firebaseService reads FIREBASE_DATABASE_URL
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split(/\r?\n/).forEach((line) => {
    const match = line.match(/^\s*([\w.]+)\s*=\s*(.*)$/);
    if (match && !(match[1] in process.env)) {
      process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
    }
  });
}

const { fbGet, fbSet } = require('../api/firebaseService');
const { archiveStories } = require('../api/archiveService');
const {
  SPANISH_YOUTUBE_CHANNELS,
  TRANSCRIPT_CACHE_PATH,
  fetchChannelVideos,
  listAllChannelVideos,
  downloadTranscriptWithInfo,
  extractVideoId,
  parseRelativeDate,
} = require('../api/youtubeService');

// Flags can arrive as arguments or, when npm swallows them (e.g. PowerShell drops the `--`
// in `npm run cache-transcripts -- --all`), as npm_config_* environment variables.
const args = process.argv.slice(2);
const ALL = args.includes('--all') || process.env.npm_config_all === 'true';
const LIMIT = Number(
  (args.find((a) => a.startsWith('--limit=')) || '').split('=')[1] || process.env.npm_config_limit,
) || Infinity;
// Pause between YouTube downloads so a long backfill doesn't get your IP rate limited
const DELAY_MS = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// New uploads often get auto-captions a few hours later, so recheck those sooner
function shouldRecheck(record, publishedAt) {
  const age = Date.now() - (publishedAt || 0);
  const wait = age < 14 * DAY_MS ? DAY_MS / 2 : 30 * DAY_MS;
  return Date.now() - (record.checked_at || 0) > wait;
}

async function* videosFor(channel) {
  if (ALL) {
    for await (const video of listAllChannelVideos(channel.channelId)) {
      yield {
        videoId: video.videoId,
        story: {
          headline: video.headline,
          summary: video.summary,
          link: `https://www.youtube.com/watch?v=${video.videoId}`,
          source: channel.source,
          lang: channel.lang,
          type: 'video',
          published_at: parseRelativeDate(video.publishedText),
        },
      };
    }
    return;
  }
  const videos = await fetchChannelVideos({ ...channel, limit: 15 });
  for (const story of videos) yield { videoId: extractVideoId(story.link), story };
}

async function main() {
  if (!process.env.FIREBASE_DATABASE_URL) {
    console.error('FIREBASE_DATABASE_URL must be set (in the environment or in .env).');
    process.exit(1);
  }

  const counts = { cached: 0, unavailable: 0, skipped: 0 };
  let downloads = 0;

  for (const channel of SPANISH_YOUTUBE_CHANNELS) {
    console.log(`${channel.source}: ${ALL ? 'all videos' : 'latest videos'}`);

    for await (const { videoId, story } of videosFor(channel)) {
      if (downloads >= LIMIT) break;
      const key = `${TRANSCRIPT_CACHE_PATH}/${videoId}`;
      const existing = await fbGet(key);

      if (existing && existing.content) {
        // Exact publish date from an earlier download beats the "hace N meses" estimate
        await archiveStories([{ ...story, published_at: existing.published_at || story.published_at }]);
        counts.skipped += 1;
        continue;
      }
      if (existing && existing.unavailable && !shouldRecheck(existing, story.published_at)) {
        counts.skipped += 1;
        continue;
      }

      downloads += 1;
      try {
        const { content, publishedAt } = await downloadTranscriptWithInfo(videoId, { lang: channel.lang });
        const published_at = publishedAt || story.published_at;
        if (!(await fbSet(key, { videoId, content, published_at, cached_at: Date.now() }))) {
          throw new Error('Firebase write failed');
        }
        await archiveStories([{ ...story, published_at }]);
        counts.cached += 1;
        console.log(`  cached       ${videoId}  ${story.headline}`);
      } catch (err) {
        if (err.blocked) {
          console.error(`  YouTube is blocking requests from this machine; stopping. ${err.message}`);
          break;
        }
        await fbSet(key, { videoId, unavailable: true, reason: err.message.slice(0, 500), checked_at: Date.now() });
        counts.unavailable += 1;
        console.warn(`  unavailable  ${videoId}  ${story.headline}`);
      }
      await sleep(DELAY_MS);
    }
  }

  console.log(
    `${new Date().toISOString()} Done: ${counts.cached} new transcripts cached, ` +
      `${counts.unavailable} unavailable, ${counts.skipped} already done.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
