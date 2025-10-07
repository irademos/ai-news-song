const express = require('express');
const path = require('path');
const { fetchTopNews } = require('./newsService');

const app = express();

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
