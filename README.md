# Daily Spin

Daily Spin is a lightweight Express application that serves a single-page site for sharing a featured song along with a small archive of previous picks. The page renders a built-in audio player for the current track while the sidebar lists songs from earlier days that listeners can revisit.

## Getting Started

```bash
npm install
npm start
```

The development server runs on port 3000 by default. Once running, open [http://localhost:3000](http://localhost:3000) to interact with the player.

## Project Structure

```
api/            Express application with in-memory song data
components/     Static HTML page rendered for every request
public/         Place any additional static assets here
```

## Customising the Playlist

Update the array in [`api/index.js`](api/index.js) to adjust the tracks, descriptions, or dates that populate the interface. Each song entry includes:

- `title` – Track name displayed in the player and sidebar
- `artist` – Artist credit displayed alongside the date
- `date` – ISO string (`YYYY-MM-DD`) used to sort and render the featured day
- `isToday` – Flag that highlights the currently featured song
- `streamUrl` – Direct URL to an MP3 stream used by the built-in audio element
- `description` – Short blurb rendered beneath the player

The front-end automatically refreshes when reloading the page, so no extra build steps are required after editing the list.

## Spanish archive

The Spanish page's **Archivo** button browses older stories and videos month by month. Stories from the Spanish RSS feeds are saved to Firebase under `spanish_archive/<YYYY-MM>/` as the feeds are loaded (at most every 15 minutes), and the transcript script adds every video it processes. Translated English stories are not archived.

## YouTube transcripts on the Spanish page

Videos from the channels in `SPANISH_YOUTUBE_CHANNELS` (`api/youtubeService.js`) are listed alongside the Spanish news feeds, and their transcripts are shown as the article text. Transcripts are cached in Firebase under `youtube_transcripts/` without expiry.

YouTube often blocks transcript requests from cloud hosts like Vercel. To work around this, pre-fill the cache from a home connection. Put `FIREBASE_DATABASE_URL=https://<project>.firebaseio.com` in `.env`, then run:

```bash
npm run cache-transcripts                  # latest ~15 videos per channel
npm run cache-transcripts:all              # every video on the channel (one-time backfill)
npm run cache-transcripts:all -- --limit=200
npm run cache-transcripts:all -- --retry-unavailable   # retry videos previously marked as having no transcript
```

`--all` pauses 2 seconds between videos and skips anything already cached, so it can be stopped and re-run to resume. Videos without Spanish captions are recorded and rechecked later (after 12 hours for videos under two weeks old, otherwise after 30 days). If YouTube starts blocking the machine, the run stops.

To run it every 3 hours on Windows (output goes to `cache-transcripts.log`):

```bat
schtasks /Create /TN "ai-news-song transcripts" /SC HOURLY /MO 3 /TR "\"C:\path\to\ai-news-song\scripts\cache-transcripts.cmd\""
```

On macOS/Linux, add a crontab entry: `0 */3 * * * cd /path/to/ai-news-song && npm run cache-transcripts >> cache-transcripts.log 2>&1`
