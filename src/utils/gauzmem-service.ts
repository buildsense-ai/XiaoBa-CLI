import axios, { AxiosInstance } from 'axios';
import { Logger } from './logger';

/**
 * GauzMem 记忆消息接口
 */
export interface GauzMemMessage {
  text: string;
  user_id: string;
  agent_id: string;
  speaker: 'user' | 'agent';
}

/**
 * 写入记忆请求
 */
export interface WriteMemoryRequest {
  project_id: string;
  message: GauzMemMessage;
}

/**
 * 搜索记忆请求
 */
export interface SearchMemoryRequest {
  project_id: string;
  query: string;
  top_k?: number;
  expansions?: {
    graph?: {
      enabled: boolean;
      max_hops: number;
    };
  };
}

/**
 * 搜索结果项
 */
export interface SearchResultItem {
  text: string;
  score?: number;
  metadata?: any;
}

/**
 * 记忆事实
 */
export interface MemoryFact {
  content: string;
}

/**
 * 记忆块
 */
export interface MemoryChunk {
  content: string;
}

/**
 * 记忆主题
 */
export interface MemoryTopic {
  content: string;
  title: string;
}

/**
 * 记忆束
 */
export interface MemoryBundle {
  bundle_id: number;
  facts: MemoryFact[];
  chunks: MemoryChunk[];
  topics: MemoryTopic[];
}

/**
 * 搜索记忆响应
 */
export interface SearchMemoryResponse {
  success: boolean;
  query: string;
  project_id: string;
  short_term_memory: any;
  bundles: MemoryBundle[];
  total_bundles: number;
  search_time_ms: number;
}

/**
 * GauzMem 配置
 */
export interface GauzMemConfig {
  baseUrl: string;
  projectId: string;
  userId: string;
  agentId: string;
  enabled: boolean;
}

/**
 * GauzMem 记忆服务
 */
export class GauzMemService {
  private client: AxiosInstance;
  private config: GauzMemConfig;

  constructor(config: GauzMemConfig) {
    this.config = config;
    this.client = axios.create({
      baseURL: config.baseUrl,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * 写入记忆
   */
  async writeMemory(text: string, speaker: 'user' | 'agent'): Promise<boolean> {
    if (!this.config.enabled) {
      return false;
    }

    try {
      const request: WriteMemoryRequest = {
        project_id: this.config.projectId,
        message: {
          text,
          user_id: this.config.userId,
          agent_id: this.config.agentId,
          speaker,
        },
      };

      await this.client.post('/api/v1/memories/messages', request);
      Logger.info(`记忆已写入: ${speaker} - ${text.substring(0, 50)}...`);
      return true;
    } catch (error) {
      Logger.error('写入记忆失败: ' + String(error));
      return false;
    }
  }

  /**
   * 搜索记忆
   */
  async searchMemory(
    query: string,
    topK: number = 5
  ): Promise<SearchResultItem[]> {
    if (!this.config.enabled) {
      return [];
    }

    try {
      const request: SearchMemoryRequest = {
        project_id: this.config.projectId,
        query,
        top_k: topK,
        expansions: {
          graph: {
            enabled: true,
            max_hops: 1,
          },
        },
      };

      const response = await this.client.post<SearchMemoryResponse>(
        '/api/v1/memories/search/bundle',
        request
      );

      // 解析 bundles 数据结构
      const results: SearchResultItem[] = [];
      const bundles = response.data.bundles || [];

      for (const bundle of bundles) {
        // 添加 facts
        if (bundle.facts) {
          for (const fact of bundle.facts) {
            results.push({ text: fact.content });
          }
        }
        // 添加 chunks
        if (bundle.chunks) {
          for (const chunk of bundle.chunks) {
            results.push({ text: chunk.content });
          }
        }
        // 添加 topics
        if (bundle.topics) {
          for (const topic of bundle.topics) {
            results.push({
              text: `[主题: ${topic.title}] ${topic.content}`,
              metadata: { title: topic.title }
            });
          }
        }
      }

      Logger.info(`搜索到 ${results.length} 条相关记忆`);
      return results;
    } catch (error) {
      Logger.error('搜索记忆失败: ' + String(error));
      return [];
    }
  }

  /**
   * 格式化搜索结果为上下文文本
   */
  formatMemoriesAsContext(memories: SearchResultItem[]): string {
    if (memories.length === 0) {
      return '';
    }

    const contextLines = [
      '=== 相关历史记忆 ===',
      ...memories.map((m, i) => `${i + 1}. ${m.text}`),
      '=== 记忆结束 ===',
      '',
    ];

    return contextLines.join('\n');
  }
}
