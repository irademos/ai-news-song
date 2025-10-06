require('dotenv').config();

const express = require('express');
const Counter = require('typescript-collections');
const app = express();
const { sql } = require('@vercel/postgres');
const nodemailer = require('nodemailer');
const axios = require('axios');
const cheerio = require('cheerio');
const { format } = require('date-fns');
const bodyParser = require('body-parser');
const path = require('path');
const nodeGeocoder = require('node-geocoder');
const moment = require('moment-timezone');
const geolib = require('geolib');

let matchedLinks: string[] = [];

const geocoder = nodeGeocoder({
    provider: 'openstreetmap'
    // provider: 'google'
});

app.use(express.json());
app.use(express.static('public'));

app.get('/', function (req, res) {
    res.sendFile(path.join(__dirname, '..', 'components', 'events.htm'));
});

let rawEventList: any[] = [];
app.get('/scrape', async (req, res) => {
    try {
        rawEventList.length = 0;
        await scrapeLoafing();
        res.json(rawEventList); // Return raw structured event list
    } catch (error) {
        console.error(error);
        res.status(500).send('Scraping failed');
    }
});

function summarizeText(text: string): string {
    const maxSentences = 3;
    const maxChars = 300;

    const sentences = text.split(/(?<=[.!?])\s+/);
    if (text.length <= maxChars) {
        return text;
    }

    // Word frequency map
    const freq: { [key: string]: number } = {};
    const words = text.toLowerCase().match(/\w+/g) || [];
    words.forEach(word => {
        freq[word] = (freq[word] || 0) + 1;
    });

    type SentenceScore = { score: number; sentence: string };

    const sentenceScores: SentenceScore[] = sentences.map((sentence): SentenceScore => {
        const wordList: string[] = sentence.toLowerCase().match(/\w+/g) || [];
        const score: number = wordList.reduce((acc: number, word: string) => {
            const wordFreq = Number(freq[word] || 0);
            return acc + wordFreq;
        }, 0);
        return { sentence, score };
    });

    sentenceScores.sort((a, b) => b.score - a.score);

    const summary: string[] = [];
    let totalChars = 0;

    for (const { sentence } of sentenceScores) {
        if (summary.length >= maxSentences) break;
        if (totalChars + sentence.length <= maxChars) {
            summary.push(sentence);
            totalChars += sentence.length;
        }
    }

    return summary.join(' ');
}

function generateGoogleMapsLink(latitude: number, longitude: number, address: string): string {
    if (address && address.trim() !== '') {
        return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address.trim())}`;
    } else if (!isNaN(latitude) && !isNaN(longitude)) {
        return `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
    }
    return '';
}

async function cycleMatchedLinks() {
    console.log('Cycling Creative Loafing links...');
    
    for (let i = 0; i < matchedLinks.length; i++) {
        const link = matchedLinks[i];
        try {
            const eventDetails = await scrapeEvent(link);
            if (eventDetails) {
                rawEventList.push(eventDetails);
            }
        } catch (error) {
            console.error(`Error processing link: ${link}`, error);
        }
    }
}

async function scrapeLoafing() {
    try {
        const url = 'https://creativeloafing.com/';
        const response = await axios.get(url);

        if (response.status === 200) {
            const baseURL = 'https://creativeloafing.com';
            const $ = cheerio.load(response.data);

            // Extract all event links from the <a> tags inside .latest-title
            const links = $('span.latest-title a')
                .map((_, link) => $(link).attr('href'))
                .get()
                .filter((href) => href && /^event-\d+-[a-z0-9-]+$/.test(href));

            console.log(links);

            matchedLinks = links.map((href: string) => new URL(href, url).href);

            await cycleMatchedLinks();
        } else {
            console.error(`Failed to retrieve Creative Loafing. Status: ${response.status}`);
        }
    } catch (error) {
        console.error('Error scraping Creative Loafing:', error);
    }
}

async function scrapeEvent(url: string) {
    try {
        const response = await axios.get(url);
        const $ = cheerio.load(response.data);
        // console.log($.html());

        const title = $('h1').text().trim();

        // Extract and format the date
        const dateTimeString = $('time').attr('datetime') || '';
        const startDate = moment.tz(dateTimeString, 'America/New_York');
        const date = startDate.format('ddd M/D h:mmA'); // Format as "Mon 4/28 6:00PM"
        
        let description = $('meta[name="description"]').attr('content') || '';
        if (description && typeof description == 'string') {
            description = summarizeText(description);
        }
        description = description.replace(/\n/g, '');
        
        const cost = $('span.cost strong').text().replace('Cost: ', '').trim();
        const venue = $('div.event-venue h3 a').text().trim() || '';
        const street = $('div.address [itemprop="streetAddress"]').text().trim();
        const city = $('div.address [itemprop="addresslocality"]').text().trim();
        const region = $('div.address [itemprop="addressRegion"]').text().trim();
        const postal = $('div.address [itemprop="postalCode"]').text().trim();
        const address = [street, city, region, postal].filter(Boolean).join(', ');

        // Extract latitude and longitude
        const latitude = parseFloat($('div[itemprop="geo"] meta[itemprop="latitude"]').attr('content') || '');
        const longitude = parseFloat($('div[itemprop="geo"] meta[itemprop="longitude"]').attr('content') || '');

        let distance = 1000.00;

        if (!isNaN(latitude) && !isNaN(longitude)) {
            const mariettaCoords = { latitude: 33.9526, longitude: -84.5499 }; // Marietta, GA 30066 approx
            const eventCoords = { latitude, longitude };

            const distMeters = geolib.getDistance(eventCoords, mariettaCoords); // distance in meters
            const distMiles = geolib.convertDistance(distMeters, 'mi'); // convert meters to miles

            distance = distMiles.toFixed(2);
        }

        const source = "Creative Loafing";
        const sourceUrl = url;
        const mapsUrl = generateGoogleMapsLink(latitude, longitude, address);;
        const website = $('div.col-sm-8 a[href^="http"]').filter(function () {
            return $(this).text().toLowerCase().includes('more information');
        }).attr('href') || '';        

        return { title, date, description, address, distance, latitude, longitude, venue, cost, source, sourceUrl, mapsUrl, website };

    } catch (error) {
        console.error('Error scraping event details:', error);
        return null;
    }
}

async function getCoordsFromZip(zip) {
  try {
    const res = await fetch(`http://api.zippopotam.us/us/${zip}`);
    if (!res.ok) throw new Error('ZIP not found');

    const data = await res.json();
    const { latitude, longitude } = data.places[0];

    return {
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
    };
  } catch (err) {
    console.error("ZIP lookup error:", err);
    throw new Error('ZIP error');
  }
}


function getDistance(a, userCoords) {
    if (!a.latitude || !a.longitude) return null; // return null instead of false
    const dist = geolib.getDistance(
        { latitude: a.latitude, longitude: a.longitude },
        userCoords
    );
    
    const distMiles = geolib.convertDistance(dist, 'mi');
    // console.log(a.latitude, a.longitude, userCoords, dist, distMiles, parseFloat(distMiles.toFixed(2)));
    return parseFloat(distMiles.toFixed(2)); // return as number
}

app.post('/getFilteredEvents', async (req, res) => {
    const { zip, allEvents } = req.body;
    const userCoords = await getCoordsFromZip(zip);

    if (!userCoords) {
        return;
    }
  
    const filtered = allEvents.sort((a, b) => {
      const distA = getDistance(a, userCoords) ?? 1000.00;
      const distB = getDistance(b, userCoords) ?? 1000.00;

      a.distance = distA;
      b.distance = distB;

      if (distA !== distB) return distA - distB;
      const costA = parseFloat(a.cost) || 0;
      const costB = parseFloat(b.cost) || 0;
      return costA - costB;
    });

    res.json(filtered);
});

module.exports = app;