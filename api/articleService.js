const DEFAULT_HEADERS = {
  'User-Agent': 'Daily-Spin/1.0 (+https://example.com)',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
};

function normaliseWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, ' ');
}

function extractCandidateBlocks(html) {
  const blocks = [];
  const articleMatch = html.match(/<article[\s\S]*?<\/article>/i);
  if (articleMatch) {
    blocks.push(articleMatch[0]);
  }

  const mainMatch = html.match(/<main[\s\S]*?<\/main>/i);
  if (mainMatch) {
    blocks.push(mainMatch[0]);
  }

  const bodyMatch = html.match(/<body[\s\S]*?<\/body>/i);
  if (bodyMatch) {
    blocks.push(bodyMatch[0]);
  } else {
    blocks.push(html);
  }

  return blocks;
}

function extractParagraphs(html) {
  const cleaned = html
    .replace(/<(script|style|noscript|iframe)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--.*?-->/gs, ' ');

  const paragraphs = [];
  const regex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let match;

  while ((match = regex.exec(cleaned)) !== null) {
    const text = normaliseWhitespace(decodeEntities(stripTags(match[1] || '')));
    if (text && text.length > 60) {
      paragraphs.push(text);
    }
  }

  if (paragraphs.length) {
    return paragraphs;
  }

  const fallback = normaliseWhitespace(decodeEntities(stripTags(cleaned)));
  return fallback ? [fallback] : [];
}

function mergeParagraphs(paragraphs) {
  const seen = new Set();
  const ordered = [];

  paragraphs.forEach((paragraph) => {
    const key = paragraph.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push(paragraph);
  });

  return ordered;
}

async function fetchArticleContent(url) {
  if (!url || typeof url !== 'string') {
    throw new Error('A valid article URL must be provided.');
  }

  const response = await fetch(url, { headers: DEFAULT_HEADERS });
  if (!response.ok) {
    throw new Error(`Failed to retrieve article (status ${response.status})`);
  }

  const html = await response.text();
  const blocks = extractCandidateBlocks(html);

  for (const block of blocks) {
    const paragraphs = mergeParagraphs(extractParagraphs(block));
    const candidate = paragraphs.join('\n\n');
    if (candidate.length > 400) {
      return candidate;
    }
  }

  const fallbackParagraphs = mergeParagraphs(extractParagraphs(html));
  const fallback = fallbackParagraphs.join('\n\n');
  if (fallback.length > 200) {
    return fallback;
  }

  throw new Error('Unable to extract article content from the provided URL.');
}

module.exports = {
  fetchArticleContent,
};
