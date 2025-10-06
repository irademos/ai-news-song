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
