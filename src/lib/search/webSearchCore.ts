/** @doc Server-only web search core: You.com search with smart key rotation from the Supabase key pool (provider "y"). */
import { createClient } from "@supabase/supabase-js";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResponse {
  results: WebSearchResult[];
  error?: string;
}

function serverClient() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("Supabase server credentials are not configured");
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

function normalise(payload: any): WebSearchResult[] {
  const buckets: any[] = [];
  if (Array.isArray(payload?.results)) buckets.push(...payload.results);
  if (Array.isArray(payload?.hits)) buckets.push(...payload.hits);
  if (Array.isArray(payload?.web?.results)) buckets.push(...payload.web.results);
  if (Array.isArray(payload?.data?.results)) buckets.push(...payload.data.results);
  if (Array.isArray(payload?.results?.web)) buckets.push(...payload.results.web);

  const out: WebSearchResult[] = [];
  for (const item of buckets) {
    const url = item?.url || item?.link || item?.source_url;
    if (!url) continue;
    const snippets = Array.isArray(item?.snippets) ? item.snippets.join(" ") : "";
    const snippet =
      snippets ||
      item?.snippet ||
      item?.description ||
      item?.text ||
      item?.content ||
      "";
    out.push({
      title: String(item?.title || item?.name || url).slice(0, 220),
      url: String(url),
      snippet: String(snippet).replace(/\s+/g, " ").slice(0, 900),
    });
  }
  // De-duplicate by URL.
  const seen = new Set<string>();
  return out.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)));
}

async function callYou(apiKey: string, query: string, count: number) {
  const url = new URL("https://api.you.com/v1/search");
  url.searchParams.set("query", query);
  url.searchParams.set("count", String(Math.min(Math.max(count, 1), 20)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const resp = await fetch(url.toString(), {
      headers: { "X-API-Key": apiKey, Accept: "application/json" },
      signal: controller.signal,
    });
    const text = await resp.text();
    if (!resp.ok) {
      return { ok: false as const, status: resp.status, error: text.slice(0, 300) };
    }
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false as const, status: 502, error: "invalid json" };
    }
    return { ok: true as const, results: normalise(json) };
  } catch (err) {
    return {
      ok: false as const,
      status: 599,
      error: err instanceof Error ? err.message : "network error",
    };
  } finally {
    clearTimeout(timer);
  }
}

function decodeHtml(input: string): string {
  return input
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Keyless fallback provider so Deep Research always has live sources. */
async function duckDuckGoSearch(query: string, count: number): Promise<WebSearchResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const resp = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      },
      body: new URLSearchParams({ q: query }).toString(),
      signal: controller.signal,
    });
    if (!resp.ok) return { results: [], error: `search HTTP ${resp.status}` };
    const html = await resp.text();
    const results: WebSearchResult[] = [];
    const seen = new Set<string>();
    const blockRe =
      /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="[^"]*result__a|<\/div>\s*<\/div>\s*<\/div>)/g;
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(html)) && results.length < count) {
      let url = m[1];
      const uddg = url.match(/[?&]uddg=([^&]+)/);
      if (uddg) url = decodeURIComponent(uddg[1]);
      if (!/^https?:\/\//.test(url) || seen.has(url)) continue;
      const snippetMatch = m[3].match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/);
      seen.add(url);
      results.push({
        title: decodeHtml(m[2]).slice(0, 220),
        url,
        snippet: snippetMatch ? decodeHtml(snippetMatch[1]).slice(0, 900) : "",
      });
    }
    return results.length ? { results } : { results: [], error: "no results" };
  } catch (err) {
    return { results: [], error: err instanceof Error ? err.message : "search failed" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs a web search, rotating through the pooled keys. A key that errors is
 * reported (3 strikes → blocked) and the next key is tried automatically.
 */
export async function webSearch(query: string, count = 8): Promise<WebSearchResponse> {
  const trimmed = (query || "").trim();
  if (!trimmed) return { results: [], error: "empty query" };

  let supabase: ReturnType<typeof serverClient>;
  try {
    supabase = serverClient();
  } catch {
    // No server credentials (local/preview runtime): Deep Research still needs
    // live sources, so fall back to the keyless provider instead of returning
    // an empty list, which makes the model answer without any evidence.
    return duckDuckGoSearch(trimmed, count);
  }
  let lastError = "no keys configured";

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { data, error } = await supabase.rpc("next_provider_key", { p_provider: "y" });
    const row = Array.isArray(data) ? (data[0] as { id: string; api_key: string } | undefined) : undefined;
    if (error) return duckDuckGoSearch(trimmed, count);
    if (!row?.api_key) return { results: [], error: lastError };

    const result = await callYou(row.api_key, trimmed, count);
    if (result.ok && result.results.length) {
      await supabase.rpc("report_provider_key_success", { p_key_id: row.id });
      return { results: result.results };
    }
    if (result.ok) {
      await supabase.rpc("report_provider_key_success", { p_key_id: row.id });
      return { results: [] };
    }
    lastError = `HTTP ${result.status}`;
    await supabase.rpc("report_provider_key_failure", {
      p_key_id: row.id,
      p_error: `${result.status}: ${result.error}`.slice(0, 300),
    });
  }

  return { results: [], error: lastError };
}
