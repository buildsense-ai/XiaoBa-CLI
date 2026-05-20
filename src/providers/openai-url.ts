/**
 * Normalize OpenAI Chat Completions compatible URLs.
 *
 * Many OpenAI-compatible services document a SDK-style baseURL, e.g.
 * https://api.deepseek.com or https://api.openai.com/v1. This runtime still
 * sends HTTP requests directly, so it needs the concrete chat completions
 * endpoint.
 */
export function normalizeOpenAIChatCompletionsUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return trimmed;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }

  const path = parsed.pathname.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(path)) {
    parsed.pathname = path;
    return parsed.toString();
  }

  parsed.pathname = `${path || ''}/chat/completions`;
  return parsed.toString();
}
