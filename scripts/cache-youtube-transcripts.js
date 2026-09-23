#!/usr/bin/env node
// Pre-fills the Firebase transcript cache for the Spanish page's YouTube channels.
//
// YouTube often blocks transcript requests from cloud servers such as Vercel, but not from
// home connections. Run this from your own computer (e.g. on a schedule) and the site will
// serve the cached transcripts without ever calling YouTube itself:
//
//   npm run cache-transcripts
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
const {
  SPANISH_YOUTUBE_CHANNELS,
  fetchChannelVideos,
  downloadYoutubeTranscript,
  extractVideoId,
} = require('../api/youtubeService');

async function main() {
  if (!process.env.FIREBASE_DATABASE_URL) {
    console.error('FIREBASE_DATABASE_URL must be set (in the environment or in .env).');
    process.exit(1);
  }

  let cached = 0;
  let failed = 0;
  for (const channel of SPANISH_YOUTUBE_CHANNELS) {
    const videos = await fetchChannelVideos({ ...channel, limit: 15 });
    console.log(`${channel.source}: ${videos.length} recent videos`);

    for (const video of videos) {
      const videoId = extractVideoId(video.link);
      const key = `youtube_transcripts/${videoId}`;
      const existing = await fbGet(key);
      if (existing && existing.content) continue;

      try {
        const content = await downloadYoutubeTranscript(videoId, { lang: channel.lang });
        const saved = await fbSet(key, { videoId, content, cached_at: Date.now() });
        if (!saved) throw new Error('Firebase write failed');
        cached += 1;
        console.log(`  cached   ${videoId}  ${video.headline}`);
      } catch (err) {
        failed += 1;
        console.warn(`  skipped  ${videoId}  ${err.message}`);
      }
    }
  }

  console.log(`${new Date().toISOString()} Done: ${cached} new transcripts cached, ${failed} unavailable.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
