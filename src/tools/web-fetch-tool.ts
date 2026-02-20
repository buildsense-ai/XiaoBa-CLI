import axios from 'axios';
import TurndownService from 'turndown';
import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { Logger } from '../utils/logger';

/**
 * Web Fetch 工具 - 获取网页内容并转为 Markdown
 */
export class WebFetchTool implements Tool {
  definition: ToolDefinition = {
    name: 'web_fetch',
    description:
      '获取网页内容并转为 Markdown。适用于文章、文档等静态页面。' +
      '如果返回内容不完整或页面依赖 JavaScript 动态渲染，请改用 agent-browser skill 获取完整内容。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '完整的 http/https URL',
        },
        max_chars: {
          type: 'number',
          description: '最大字符数（默认 20000）',
        },
        timeout_seconds: {
          type: 'number',
          description: '超时秒数（默认 15）',
        },
        prefer: {
          type: 'string',
          enum: ['markdown', 'text', 'html'],
          description: '输出格式（默认 markdown）',
        },
      },
      required: ['url'],
    },
  };

  private turndown: TurndownService;

  constructor() {
    this.turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
    });

    // 忽略图片（减少噪音）
    this.turndown.addRule('removeImages', {
      filter: 'img',
      replacement: (_content: string, node: unknown) => {
        const alt = (node as any).getAttribute?.('alt') || '';
        return alt ? `[图片: ${alt}]` : '';
      },
    });
  }

  async execute(args: any, _context: ToolExecutionContext): Promise<string> {
    const {
      url,
      max_chars = 20000,
      timeout_seconds = 15,
      prefer = 'markdown',
    } = args;

    // URL 校验
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      return '错误: 请提供完整的 http/https URL';
    }

    Logger.info(`🌐 获取网页: ${url}`);

    try {
      const resp = await axios.get(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
        },
        timeout: timeout_seconds * 1000,
        maxRedirects: 5,
        responseType: 'text',
      });

      const contentType: string = resp.headers['content-type'] || '';
      const rawHtml: string = resp.data;

      if (!contentType.includes('text/html') && !contentType.includes('text/plain') && !contentType.includes('application/xhtml')) {
        return `该 URL 返回的内容类型为 ${contentType}，不是 HTML 页面。无法提取文本内容。`;
      }

      // 提取页面标题
      const titleMatch = rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = titleMatch
        ? titleMatch[1].replace(/\s+/g, ' ').trim()
        : '';

      let output: string;

      if (prefer === 'html') {
        output = rawHtml;
      } else {
        // 清理 HTML: 移除噪音标签
        const cleanedHtml = this.cleanHtml(rawHtml);

        if (prefer === 'text') {
          output = this.htmlToText(cleanedHtml);
        } else {
          // markdown (默认)
          output = this.turndown.turndown(cleanedHtml);
          // 清理多余空行
          output = output.replace(/\n{3,}/g, '\n\n').trim();
        }
      }

      // 截断
      let truncated = false;
      if (output.length > max_chars) {
        output = output.substring(0, max_chars);
        truncated = true;
      }

      const header = `URL: ${url}${title ? `\n标题: ${title}` : ''}\n字符数: ${output.length}${truncated ? ' [内容已截断]' : ''}\n\n---\n\n`;

      Logger.success(
        `✓ 获取成功: ${output.length} 字符${truncated ? ' (已截断)' : ''}`,
      );

      return header + output;
    } catch (error: any) {
      const status = error.response?.status;
      const statusText = error.response?.statusText || '';
      let msg: string;

      if (status) {
        msg = `HTTP ${status} ${statusText}`;
      } else if (error.code === 'ECONNABORTED') {
        msg = `请求超时 (${timeout_seconds}s)`;
      } else {
        msg = error.message;
      }

      Logger.error(`✗ 获取失败: ${msg}`);

      return (
        `获取网页失败: ${msg}\nURL: ${url}\n\n` +
        `提示: 如果页面需要 JavaScript 渲染或需要交互，可以使用 agent-browser skill 来获取完整内容。`
      );
    }
  }

  /**
   * 清理 HTML — 移除 script/style/nav 等噪音标签
   */
  private cleanHtml(html: string): string {
    return html
      // 移除 script 和 style 标签及其内容
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
      // 移除导航、页脚、页头等噪音区域
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      // 移除 HTML 注释
      .replace(/<!--[\s\S]*?-->/g, '')
      // 移除 SVG
      .replace(/<svg[\s\S]*?<\/svg>/gi, '');
  }

  /**
   * HTML 转纯文本
   */
  private htmlToText(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<\/h[1-6]>/gi, '\n\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}
