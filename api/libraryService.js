// Free Spanish reading library: public-domain short stories and legends from Spanish
// Wikisource, organised by collection and learner level. Each entry names its Wikisource
// page; if that title ever moves, the story is found again with a full-text search on its
// title and author, so the catalogue keeps working when pages are renamed.

const WIKISOURCE_API = 'https://es.wikisource.org/w/api.php';
const WIKISOURCE_PAGE = 'https://es.wikisource.org/wiki/';

const LEVELS = [
  { id: 'principiante', label: 'Principiante', hint: 'Frases cortas y vocabulario cotidiano' },
  { id: 'intermedio', label: 'Intermedio', hint: 'Narraciones clásicas de extensión media' },
  { id: 'avanzado', label: 'Avanzado', hint: 'Lenguaje literario y textos más largos' },
];

const SPANISH_LIBRARY = [
  {
    id: 'cuentos-de-la-selva',
    title: 'Cuentos de la selva',
    author: 'Horacio Quiroga',
    year: 1918,
    level: 'principiante',
    description: 'Fábulas de animales de la selva de Misiones, escritas para niños. Ideales para empezar.',
    stories: [
      { id: 'la-tortuga-gigante', title: 'La tortuga gigante', page: 'La tortuga gigante' },
      { id: 'las-medias-de-los-flamencos', title: 'Las medias de los flamencos', page: 'Las medias de los flamencos' },
      { id: 'el-loro-pelado', title: 'El loro pelado', page: 'El loro pelado' },
      { id: 'la-abeja-haragana', title: 'La abeja haragana', page: 'La abeja haragana' },
      { id: 'la-gama-ciega', title: 'La gama ciega', page: 'La gama ciega' },
      { id: 'la-guerra-de-los-yacares', title: 'La guerra de los yacarés', page: 'La guerra de los yacarés' },
      { id: 'el-paso-del-yabebiri', title: 'El paso del Yabebirí', page: 'El paso del Yabebirí' },
    ],
  },
  {
    id: 'leyendas-becquer',
    title: 'Leyendas',
    author: 'Gustavo Adolfo Bécquer',
    year: 1871,
    level: 'intermedio',
    description: 'Leyendas románticas de fantasmas, amores imposibles y misterio en la España antigua.',
    stories: [
      { id: 'el-monte-de-las-animas', title: 'El monte de las ánimas', page: 'El monte de las ánimas' },
      { id: 'los-ojos-verdes', title: 'Los ojos verdes', page: 'Los ojos verdes' },
      { id: 'el-rayo-de-luna', title: 'El rayo de luna', page: 'El rayo de luna' },
      { id: 'maese-perez-el-organista', title: 'Maese Pérez el organista', page: 'Maese Pérez el organista' },
    ],
  },
  {
    id: 'cuentos-espanoles-siglo-xix',
    title: 'Cuentos españoles del siglo XIX',
    author: 'Clarín y Emilia Pardo Bazán',
    level: 'intermedio',
    description: 'Cuentos realistas breves sobre la vida en el campo y la ciudad.',
    stories: [
      { id: 'adios-cordera', title: '¡Adiós, Cordera!', author: 'Leopoldo Alas «Clarín»', page: '¡Adiós, Cordera!' },
      { id: 'el-encaje-roto', title: 'El encaje roto', author: 'Emilia Pardo Bazán', page: 'El encaje roto' },
      { id: 'las-medias-rojas', title: 'Las medias rojas', author: 'Emilia Pardo Bazán', page: 'Las medias rojas' },
    ],
  },
  {
    id: 'tradiciones-peruanas',
    title: 'Tradiciones peruanas',
    author: 'Ricardo Palma',
    year: 1872,
    level: 'intermedio',
    description: 'Anécdotas históricas de Lima colonial, llenas de humor e ironía.',
    stories: [
      { id: 'el-alacran-de-fray-gomez', title: 'El alacrán de fray Gómez', page: 'El alacrán de fray Gómez' },
    ],
  },
  {
    id: 'cuentos-de-amor-de-locura-y-de-muerte',
    title: 'Cuentos de amor de locura y de muerte',
    author: 'Horacio Quiroga',
    year: 1917,
    level: 'avanzado',
    description: 'Los cuentos más famosos de Quiroga: intensos, oscuros y muy bien construidos.',
    stories: [
      { id: 'el-almohadon-de-plumas', title: 'El almohadón de plumas', page: 'El almohadón de plumas' },
      { id: 'a-la-deriva', title: 'A la deriva', page: 'A la deriva' },
      { id: 'la-gallina-degollada', title: 'La gallina degollada', page: 'La gallina degollada' },
    ],
  },
  {
    id: 'azul-dario',
    title: 'Azul…',
    author: 'Rubén Darío',
    year: 1888,
    level: 'avanzado',
    description: 'Cuentos del modernismo: prosa poética, rica en imágenes y vocabulario.',
    stories: [
      { id: 'el-rey-burgues', title: 'El rey burgués', page: 'El rey burgués' },
      { id: 'el-rubi', title: 'El rubí', page: 'El rubí' },
    ],
  },
];

const STORY_INDEX = new Map();
for (const collection of SPANISH_LIBRARY) {
  for (const story of collection.stories) {
    STORY_INDEX.set(story.id, { ...story, author: story.author || collection.author, collection });
  }
}

const REQUEST_HEADERS = {
  // Wikimedia asks API clients to identify themselves with a descriptive User-Agent.
  'User-Agent': 'Daily-Spin/1.0 (Spanish reading page; https://github.com/irademos/ai-news-song)',
  Accept: 'application/json',
};

function storyLink(page) {
  return WIKISOURCE_PAGE + encodeURIComponent(page.replace(/ /g, '_')).replace(/%2F/g, '/');
}

// The catalogue as sent to the page: no fetching, so it loads instantly.
function getLibraryCatalog() {
  return {
    levels: LEVELS,
    collections: SPANISH_LIBRARY.map((collection) => ({
      id: collection.id,
      title: collection.title,
      author: collection.author,
      year: collection.year,
      level: collection.level,
      description: collection.description,
      stories: collection.stories.map((story) => ({
        id: story.id,
        title: story.title,
        author: story.author || collection.author,
        link: storyLink(story.page),
      })),
    })),
  };
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&amp;/g, '&');
}

// Removes every element opened by `openPattern`, including nested elements of the same tag.
function removeElements(html, tag, openPattern) {
  let result = html;
  let match;
  const tagPattern = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  while ((match = openPattern.exec(result)) !== null) {
    tagPattern.lastIndex = match.index + match[0].length;
    let depth = 1;
    let tagMatch;
    while (depth > 0 && (tagMatch = tagPattern.exec(result)) !== null) {
      depth += tagMatch[1] ? -1 : 1;
    }
    const end = tagMatch ? tagMatch.index + tagMatch[0].length : result.length;
    result = result.slice(0, match.index) + result.slice(end);
    openPattern.lastIndex = match.index;
  }
  return result;
}

const NOISE_CLASS = /class="[^"]*\b(ws-noexport|ws-header|noprint|navbox|mw-editsection|reference|references|pagenum|ws-pagenum|licenseContainer|licencia|mw-empty-elt|toc)\b[^"]*"/i;

const LICENSE_TEXT = /(dominio público|public domain|licencia|esta obra|this work is)/i;

// Turns Wikisource page HTML into plain paragraphs separated by blank lines.
function wikisourceHtmlToText(html) {
  let cleaned = html
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  cleaned = removeElements(cleaned, 'table', /<table\b[^>]*>/gi);
  for (const tag of ['div', 'span', 'sup', 'ol', 'ul']) {
    cleaned = removeElements(cleaned, tag, new RegExp(`<${tag}\\b[^>]*${NOISE_CLASS.source}[^>]*>`, 'gi'));
  }

  const paragraphs = [];
  const blockPattern = /<(p|dd|h[2-4])\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = blockPattern.exec(cleaned)) !== null) {
    const text = decodeEntities(match[2].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''))
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
    if (!text) continue;
    if (/^h/i.test(match[1]) && text.length > 80) continue;
    paragraphs.push(text);
  }

  // Drop trailing licence and source notes.
  while (paragraphs.length && LICENSE_TEXT.test(paragraphs[paragraphs.length - 1]) && paragraphs[paragraphs.length - 1].length < 400) {
    paragraphs.pop();
  }
  return paragraphs.join('\n\n');
}

async function wikisourceRequest(params) {
  const url = `${WIKISOURCE_API}?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`;
  const response = await fetch(url, { headers: REQUEST_HEADERS });
  if (!response.ok) throw new Error(`Wikisource status ${response.status}`);
  return response.json();
}

async function fetchWikisourcePage(page) {
  const data = await wikisourceRequest({ action: 'parse', page, prop: 'text', redirects: '1' });
  if (data.error) throw new Error(data.error.info || data.error.code);
  return { title: data.parse.title, text: wikisourceHtmlToText(data.parse.text || '') };
}

// Finds the page for a story whose catalogue title no longer resolves.
async function searchWikisourcePage(story) {
  const title = story.title.replace(/[¡!¿?«»]/g, '').trim();
  for (const srsearch of [`intitle:"${title}" ${story.author}`, `intitle:"${title}"`]) {
    const data = await wikisourceRequest({ action: 'query', list: 'search', srsearch, srnamespace: '0', srlimit: '5' });
    const found = data.query?.search?.[0]?.title;
    if (found) return found;
  }
  return null;
}

// A very short result is a table of contents or disambiguation page, not the story itself.
const MIN_STORY_LENGTH = 800;

async function tryPage(page) {
  try {
    const result = await fetchWikisourcePage(page);
    return result.text.length >= MIN_STORY_LENGTH ? result : null;
  } catch {
    return null;
  }
}

// Tries the catalogue title, then the "Collection/Story" subpage that Wikisource often
// uses for collections, then a search.
async function resolveStory(story) {
  const candidates = [story.page, `${story.collection.title}/${story.title}`];
  for (const page of candidates) {
    const result = await tryPage(page);
    if (result) return result;
  }
  const found = await searchWikisourcePage(story);
  if (found && !candidates.includes(found)) return tryPage(found);
  return null;
}

async function fetchLibraryStory(id) {
  const story = STORY_INDEX.get(id);
  if (!story) return null;

  const result = await resolveStory(story);
  if (!result) throw new Error('No readable text found on Wikisource.');

  // The reader shows the title itself, so drop a leading heading that repeats it.
  const normalise = (value) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const paragraphs = result.text.split('\n\n');
  while (paragraphs.length > 1 && paragraphs[0].length < 120
    && [normalise(story.title), normalise(story.author)].includes(normalise(paragraphs[0]))) {
    paragraphs.shift();
  }

  return {
    id: story.id,
    title: story.title,
    author: story.author,
    collection: story.collection.title,
    level: story.collection.level,
    link: storyLink(result.title),
    content: paragraphs.join('\n\n'),
  };
}

module.exports = {
  LEVELS,
  SPANISH_LIBRARY,
  getLibraryCatalog,
  fetchLibraryStory,
  wikisourceHtmlToText,
};
