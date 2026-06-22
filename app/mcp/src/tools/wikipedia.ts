import { fetchWithRetry } from './fetch-retry.js';
import type { ToolModule } from './types.js';

// Wikipedia via the public REST API (https://en.wikipedia.org/api/rest_v1/).
// No API key, generous rate limit (~200 req/sec/IP), well-suited for
// spoken summaries because intro paragraphs are deliberately terse.
//
// Two tools:
//   wikipedia_search(query, lang?) — list candidate articles.
//   wikipedia_summary(title, lang?) — get the lead-section summary.
// The LLM typically chains them: search → pick best title → summary.

const ENABLED = process.env.WIKIPEDIA_TOOL_ENABLED === '1';

// Restrict the wiki language code to a safe alpha range so the LLM
// can't construct a weird URL via the `lang` param.
const LANG_RE = /^[a-z]{2,3}(-[a-z]{2,4})?$/i;
function safeLang(input: unknown): string {
  const s = String(input ?? 'en').trim().toLowerCase();
  return LANG_RE.test(s) ? s : 'en';
}

type SearchResponse = {
  pages?: Array<{
    id: number;
    key: string;
    title: string;
    excerpt?: string;
    description?: string;
  }>;
};

type SummaryResponse = {
  type?: string;
  title?: string;
  description?: string;
  extract?: string;
  content_urls?: { desktop?: { page?: string } };
};

const definitions: ToolModule['definitions'] = [
  {
    name: 'wikipedia_search',
    description:
      'Search Wikipedia and return up to 5 candidate articles (title, short description, excerpt). ' +
      'Use this first when the user asks a "what is / who is / when did" question to find the right article, ' +
      'then call wikipedia_summary on the best match. Defaults to English; pass lang="de" for German Wikipedia, etc.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query — the topic name or question keywords.' },
        lang: {
          type: 'string',
          description: 'Wikipedia language code (e.g. "en", "de", "fr"). Default "en".',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'wikipedia_summary',
    description:
      'Get the lead-section summary of a specific Wikipedia article. Returns 1-3 paragraphs of plain-text summary ' +
      'plus the article URL. Use after wikipedia_search to pull the actual content of the chosen article. ' +
      'Pass the exact title from the search results (case + spaces matter). Same lang code as the search call.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Exact article title from wikipedia_search results.' },
        lang: { type: 'string', description: 'Wikipedia language code. Default "en".' },
      },
      required: ['title'],
    },
  },
];

const handlers: ToolModule['handlers'] = {
  wikipedia_search: async (input) => {
    const query = String(input.query ?? '').trim();
    if (!query) throw new Error('query is required');
    const lang = safeLang(input.lang);
    const url = `https://${lang}.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=5`;
    const res = await fetchWithRetry(url, {
      headers: { 'User-Agent': 'paith-notes/1.0 (kiosk)' },
    });
    if (!res.ok) throw new Error(`wikipedia search ${res.status}`);
    const data = (await res.json()) as SearchResponse;
    const pages = (data.pages ?? []).map((p) => ({
      title: p.title,
      description: p.description,
      excerpt: p.excerpt?.replace(/<[^>]+>/g, '') ?? '',
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.key)}`,
    }));
    return JSON.stringify({ lang, query, results: pages });
  },

  wikipedia_summary: async (input) => {
    const title = String(input.title ?? '').trim();
    if (!title) throw new Error('title is required');
    const lang = safeLang(input.lang);
    const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`;
    const res = await fetchWithRetry(url, {
      headers: { 'User-Agent': 'paith-notes/1.0 (kiosk)' },
    });
    if (res.status === 404) {
      return JSON.stringify({ lang, title, error: 'Article not found — call wikipedia_search first to find the exact title.' });
    }
    if (!res.ok) throw new Error(`wikipedia summary ${res.status}`);
    const data = (await res.json()) as SummaryResponse;
    return JSON.stringify({
      lang,
      title: data.title,
      description: data.description,
      summary: data.extract,
      url: data.content_urls?.desktop?.page,
    });
  },
};

export const wikipediaTools: ToolModule = {
  name: 'wikipedia',
  enabled: () => ENABLED,
  definitions,
  handlers,
  // Read-only, free, no rate-limit concern at family scale.
  autoApproved: ['wikipedia_search', 'wikipedia_summary'],
};
