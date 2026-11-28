import { tavily, type TavilyClient } from "@tavily/core";
import { tool, type UIMessage } from "ai";
import { getToolContracts, type ModeType } from "@devcode/shared";

// Billing: 1 credit = $0.01. A Tavily "basic" search costs 1 Tavily credit
// (about $0.008 on pay-as-you-go), so 1 credit per search covers it.
export const CREDITS_PER_SEARCH = 1;

// One reply can span several requests (each local tool round trip is a new
// request), so the limit counts searches across the whole reply.
const MAX_SEARCHES_PER_REPLY = 5;

// Results are re-sent to the model on every later step and turn, so their
// size matters more than the search fee. Keep them small.
const MAX_RESULTS = 5;
const MAX_SNIPPET_CHARS = 500;

// Identical queries within a day reuse the earlier results.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

const SEARCH_TIMEOUT_SECONDS = 15;

type TimeRange = "day" | "week" | "month" | "year";

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
};

export type WebSearchOutput = { results: WebSearchResult[] };

let client: TavilyClient | null = null;

// Created on first use so the server still starts (and the other tools still
// work) when TAVILY_API_KEY is missing.
function getClient() {
  if (client) return client;

  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error("Web search is not configured on the server");
  }

  client = tavily({ apiKey });
  return client;
}

const cache = new Map<string, { expiresAt: number; value: WebSearchOutput }>();

function getCached(key: string) {
  const entry = cache.get(key);
  if (!entry) return undefined;

  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return undefined;
  }

  // Re-insert so the Map's insertion order works as least-recently-used.
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function setCached(key: string, value: WebSearchOutput) {
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });

  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

function truncate(value: string, limit: number) {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

async function searchWeb(
  query: string,
  timeRange: TimeRange | undefined,
): Promise<WebSearchOutput> {
  const normalizedQuery = query.trim().replace(/\s+/g, " ");
  const cacheKey = `${normalizedQuery.toLowerCase()}|${timeRange ?? ""}`;

  const cached = getCached(cacheKey);
  if (cached) return cached;

  const response = await getClient().search(normalizedQuery, {
    searchDepth: "basic",
    maxResults: MAX_RESULTS,
    includeAnswer: false,
    includeRawContent: false,
    includeImages: false,
    timeout: SEARCH_TIMEOUT_SECONDS,
    ...(timeRange ? { timeRange } : {}),
  });

  const value: WebSearchOutput = {
    results: response.results.map((result) => ({
      title: result.title,
      url: result.url,
      snippet: truncate(result.content, MAX_SNIPPET_CHARS),
      ...(result.publishedDate ? { publishedDate: result.publishedDate } : {}),
    })),
  };

  setCached(cacheKey, value);
  return value;
}

function isWebSearchPart(part: UIMessage["parts"][number]) {
  return part.type === "tool-webSearch";
}

/**
 * Adds the server's `execute` functions to the shared tool contracts.
 *
 * `currentReply` is the assistant message this request continues, if any.
 * Its earlier searches count towards the per-reply limit.
 */
export function createChatTools({
  mode,
  currentReply,
}: {
  mode: ModeType;
  currentReply: UIMessage | undefined;
}) {
  const contracts = getToolContracts(mode);
  const previousSearches =
    currentReply?.parts.filter(isWebSearchPart).length ?? 0;
  let searchesInThisRequest = 0;
  let billableSearches = 0;

  const tools = {
    ...contracts,
    webSearch: tool({
      ...contracts.webSearch,
      async execute({ query, timeRange }) {
        if (previousSearches + searchesInThisRequest >= MAX_SEARCHES_PER_REPLY) {
          throw new Error(
            `Search limit reached (${MAX_SEARCHES_PER_REPLY} per reply). Answer with the information you already have.`,
          );
        }

        searchesInThisRequest++;
        const output = await searchWeb(query, timeRange);
        // Counted after success so failed searches are never billed. Cached
        // results are billed too, so users pay the same for every search.
        billableSearches++;
        return output;
      },
    }),
  };

  return {
    tools,
    getSearchCredits: () => billableSearches * CREDITS_PER_SEARCH,
  };
}

/**
 * Shrinks web search results from earlier turns before they are sent to the
 * model. Without this, every snippet is paid for again on every later turn.
 * The model keeps the titles and URLs and can search again if it needs more.
 */
export function compactOldSearchResults<Message extends UIMessage>(
  messages: Message[],
): Message[] {
  const lastUserIndex = messages.findLastIndex((m) => m.role === "user");
  if (lastUserIndex <= 0) return messages;

  return messages.map((message, index) => {
    if (index >= lastUserIndex || message.role !== "assistant") return message;
    if (!message.parts.some(isWebSearchPart)) return message;

    return {
      ...message,
      parts: message.parts.map((part) => {
        if (!isWebSearchPart(part)) return part;
        if (!("state" in part) || part.state !== "output-available") {
          return part;
        }

        const output = (part as { output?: Partial<WebSearchOutput> }).output;
        return {
          ...part,
          output: {
            results: (output?.results ?? []).map(({ title, url }) => ({
              title,
              url,
            })),
            note: "Snippets removed from an earlier turn. Search again if you need the details.",
          },
        };
      }),
    };
  });
}
