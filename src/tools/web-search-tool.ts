import axios from 'axios';
import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { Logger } from '../utils/logger';

/**
 * 搜索结果项
 */
interface SearchResult {
  rank: number;
  title: string;
  url: string;
  snippet: string;
  source: string;
}

/**
 * Web Search 工具 - 基于 DuckDuckGo 的联网搜索
 *
 * Fallback 链：SearXNG（如配置）→ DDG HTML → DDG Instant Answer
 */
export class WebSearchTool implements Tool {
  definition: ToolDefinition = {
    name: 'web_search',
    description:
      '联网搜索工具。通过 DuckDuckGo 搜索互联网内容，返回标题、链接和摘要。' +
      '适用于查找最新资料、验证事实、获取参考文献等场景。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词',
        },
        max_results: {
          type: 'number',
          description: '最大返回条数（1-10，默认 5）',
        },
        region: {
          type: 'string',
          description: '区域参数（如 us-en, cn-zh，默认 us-en）',
        },
      },
      required: ['query'],
    },
  };

  async execute(args: any, _context: ToolExecutionContext): Promise<string> {
    const {
      query,
      max_results = 5,
      region = 'us-en',
    } = args;

    const normalizedQuery = (query || '').trim();
    if (!normalizedQuery) {
      return '错误: query 不能为空';
    }

    const maxResults = Math.max(1, Math.min(Number(max_results) || 5, 10));
    const timeoutMs = 12000;
    const warnings: string[] = [];

    Logger.info(`🔍 搜索: ${normalizedQuery}`);

    let results: SearchResult[] = [];
    let provider = 'none';

    // 1) 尝试 SearXNG（如果配置了）
    const searxngBaseUrl = (process.env.SEARXNG_BASE_URL || '').trim().replace(/\/+$/, '');
    if (searxngBaseUrl) {
      try {
        results = await this.searchSearXNG(normalizedQuery, maxResults, region, timeoutMs, searxngBaseUrl);
        provider = 'searxng';
      } catch (err: any) {
        warnings.push(`searxng_failed: ${err.message}`);
      }
    }

    // 2) Fallback: DDG HTML
    if (results.length === 0) {
      try {
        results = await this.searchDuckDuckGoHTML(normalizedQuery, maxResults, region, timeoutMs);
        provider = 'duckduckgo_html';
      } catch (err: any) {
        warnings.push(`ddg_html_failed: ${err.message}`);
      }
    }

    // 3) Fallback: DDG Instant Answer
    if (results.length === 0) {
      try {
        results = await this.searchDuckDuckGoInstant(normalizedQuery, maxResults, timeoutMs);
        provider = 'duckduckgo_instant';
      } catch (err: any) {
        warnings.push(`ddg_instant_failed: ${err.message}`);
      }
    }

    if (results.length === 0) {
      Logger.error(`✗ 搜索无结果: ${normalizedQuery}`);
      return `未获取到搜索结果。\n查询: ${normalizedQuery}\n${warnings.length > 0 ? `警告: ${warnings.join('; ')}` : ''}`;
    }

    Logger.success(`✓ 搜索到 ${results.length} 条结果 (${provider})`);

    // 格式化输出
    const lines = [
      `查询: ${normalizedQuery}`,
      `来源: ${provider} | 结果数: ${results.length}`,
      '',
    ];

    for (const r of results) {
      lines.push(`${r.rank}. ${r.title}`);
      lines.push(`   ${r.url}`);
      if (r.snippet) {
        lines.push(`   ${r.snippet}`);
      }
      lines.push('');
    }

    if (warnings.length > 0) {
      lines.push(`[warnings: ${warnings.join('; ')}]`);
    }

    return lines.join('\n');
  }

  // ─── SearXNG ───

  private async searchSearXNG(
    query: string,
    maxResults: number,
    region: string,
    timeoutMs: number,
    baseUrl: string,
  ): Promise<SearchResult[]> {
    const langMap: Record<string, string> = {
      'cn-zh': 'zh-CN', 'zh-cn': 'zh-CN',
      'us-en': 'en-US', 'en-us': 'en-US',
      'gb-en': 'en-GB', 'de-de': 'de-DE',
      'fr-fr': 'fr-FR', 'ja-jp': 'ja-JP',
    };
    const language = langMap[(region || '').toLowerCase()] || '';

    const params = new URLSearchParams({ q: query, format: 'json', safesearch: '0' });
    if (language) params.set('language', language);

    const resp = await axios.get(`${baseUrl}/search?${params}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      timeout: timeoutMs,
    });

    const rawResults = resp.data?.results;
    if (!Array.isArray(rawResults)) return [];

    const results: SearchResult[] = [];
    const seen = new Set<string>();

    for (const item of rawResults) {
      const url = (item.url || '').trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);

      results.push({
        rank: results.length + 1,
        title: this.cleanHtml(item.title || '') || query,
        url,
        snippet: this.cleanHtml(item.content || item.snippet || ''),
        source: this.extractDomain(url),
      });
      if (results.length >= maxResults) break;
    }
    return results;
  }

  // ─── DuckDuckGo HTML ───

  private async searchDuckDuckGoHTML(
    query: string,
    maxResults: number,
    region: string,
    timeoutMs: number,
  ): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: query, kl: region });
    const resp = await axios.get(`https://html.duckduckgo.com/html/?${params}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: timeoutMs,
      responseType: 'text',
    });

    const html: string = resp.data;
    const anchorRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*>.*?<\/a>/gis;
    const hrefRe = /href="([^"]+)"/i;
    const snippetRe = /class="[^"]*result__snippet[^"]*"[^>]*>(.*?)<\//is;

    const results: SearchResult[] = [];
    const seen = new Set<string>();

    let match: RegExpExecArray | null;
    while ((match = anchorRe.exec(html)) !== null) {
      const anchorHtml = match[0];
      const hrefMatch = hrefRe.exec(anchorHtml);
      if (!hrefMatch) continue;

      const url = this.normalizeUrl(hrefMatch[1]);
      if (!url || seen.has(url)) continue;
      seen.add(url);

      const title = this.cleanHtml(anchorHtml);
      const tailWindow = html.slice(match.index + match[0].length, match.index + match[0].length + 2500);
      const snippetMatch = snippetRe.exec(tailWindow);
      const snippet = snippetMatch ? this.cleanHtml(snippetMatch[1]) : '';

      results.push({
        rank: results.length + 1,
        title,
        url,
        snippet,
        source: this.extractDomain(url),
      });
      if (results.length >= maxResults) break;
    }
    return results;
  }

  // ─── DuckDuckGo Instant Answer ───

  private async searchDuckDuckGoInstant(
    query: string,
    maxResults: number,
    timeoutMs: number,
  ): Promise<SearchResult[]> {
    const params = new URLSearchParams({
      q: query, format: 'json', no_html: '1', no_redirect: '1', skip_disambig: '1',
    });
    const resp = await axios.get(`https://api.duckduckgo.com/?${params}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: timeoutMs,
    });

    const payload = resp.data || {};
    const results: SearchResult[] = [];

    // Abstract
    const abstractUrl = payload.AbstractURL || '';
    const abstractText = payload.AbstractText || '';
    const heading = payload.Heading || '';
    if (abstractUrl && (abstractText || heading)) {
      results.push({
        rank: 1,
        title: heading || query,
        url: abstractUrl,
        snippet: abstractText,
        source: this.extractDomain(abstractUrl),
      });
    }

    // Related Topics
    const related = payload.RelatedTopics || [];
    this.collectInstantTopics(related, results, maxResults);

    return results.slice(0, maxResults);
  }

  private collectInstantTopics(items: any[], results: SearchResult[], maxResults: number): void {
    for (const item of items) {
      if (results.length >= maxResults) return;
      if (!item || typeof item !== 'object') continue;

      // 嵌套 Topics
      if (Array.isArray(item.Topics)) {
        this.collectInstantTopics(item.Topics, results, maxResults);
        continue;
      }

      const text = item.Text;
      const url = item.FirstURL;
      if (!text || !url) continue;
      if (results.some(r => r.url === url)) continue;

      results.push({
        rank: results.length + 1,
        title: text.split(' - ')[0].slice(0, 120),
        url,
        snippet: text,
        source: this.extractDomain(url),
      });
    }
  }

  // ─── Helpers ───

  private cleanHtml(raw: string): string {
    return (raw || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private normalizeUrl(rawUrl: string): string {
    let candidate = (rawUrl || '').trim()
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"');

    if (!candidate) return '';
    if (candidate.startsWith('//')) candidate = `https:${candidate}`;

    try {
      const parsed = new URL(candidate);
      // DDG redirect link — extract real URL
      if (parsed.hostname.includes('duckduckgo.com') && parsed.pathname.startsWith('/l/')) {
        const uddg = parsed.searchParams.get('uddg');
        if (uddg) return decodeURIComponent(uddg);
      }
    } catch {
      // not a valid URL
    }
    return candidate;
  }

  private extractDomain(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  }
}
