/** @doc Browser helper that asks our own search endpoint for live web results. */
export interface WebSource {
  title: string;
  url: string;
  snippet: string;
}

export async function fetchWebSources(query: string, count = 8): Promise<WebSource[]> {
  try {
    const resp = await fetch("/api/web-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, count }),
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as { results?: WebSource[] };
    return Array.isArray(data.results) ? data.results : [];
  } catch {
    return [];
  }
}

/** Formats sources as a numbered context block the model can cite from. */
export function formatSourcesBlock(sources: WebSource[]): string {
  if (!sources.length) return "";
  const lines = sources
    .map((s, i) => `[${i + 1}] ${s.title}\nURL: ${s.url}\n${s.snippet}`)
    .join("\n\n");
  return [
    "Live web results for this question (fetched just now).",
    "Use them as your evidence, cite them inline as [1], [2], ... and finish with a Sources list of the URLs you actually used.",
    "",
    lines,
  ].join("\n");
}
