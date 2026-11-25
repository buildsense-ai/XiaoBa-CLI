/**
 * MCP OAuth 2.1 客户端 Provider（Track 3）。
 *
 * 实现 @modelcontextprotocol/sdk 的 OAuthClientProvider 接口：
 * - Protected Resource Metadata / AS metadata 发现、PKCE S256、token refresh、
 *   401/403 insufficient_scope step-up 全部由 SDK 的 auth() 编排器驱动 ——
 *   本模块只负责**凭据存储**与**人机授权回路**两件事。
 *
 * 授权回路（headless/cloud bot 场景，没有浏览器可弹）：
 * 1. SDK 需要用户授权时调用 redirectToAuthorization(url)；
 * 2. 我们通过注入的 `sendAuthorizationRequest` 回调，向主人的**私聊**发一张
 *    授权请求（绝不发群聊 —— 授权链接是 bearer 性质，群里发出去等于公开 token）；
 * 3. 用户在 CatsCompany 卡片里完成授权，平台回调 /api/mcp/oauth/callback，
 *    宿主把短有效期 grant/code 注入 injectAuthorizationGrant()；
 * 4. 等待中的 auth 流程用注入的 code 完成 token 交换。
 *
 * 与 skillConnectorGrants / deviceGrants 模式对齐：
 * - grant 是短命、一次性、按 (serverId, ownerUserId) 绑定的；
 * - 持久化的 token 存内存 + 可选持久化回调，绝不写进模型上下文。
 */
import crypto from 'node:crypto';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/client';
import { Logger } from '../utils/logger';

/** 授权请求（私聊卡片/文本）内容。 */
export interface OAuthAuthorizationRequest {
  serverId: string;
  ownerUserId: string;
  authorizationUrl: string;
  /** 建议的 CatsCompany 回调地址（宿主注入，供平台拼接授权完成回跳）。 */
  catscoCallbackUrl?: string;
  state?: string;
  expiresAt: number;
}

/** 宿主把授权请求投递给 owner 私聊；返回 true = 已送达。 */
export type SendOAuthAuthorizationRequest = (request: OAuthAuthorizationRequest) => Promise<boolean> | boolean;

/** token 持久化回调（可选；宿主可落到加密存储）。 */
export interface OAuthTokenStore {
  load?: (serverId: string, ownerUserId: string) => Promise<OAuthTokens | undefined> | OAuthTokens | undefined;
  save?: (serverId: string, ownerUserId: string, tokens: OAuthTokens) => Promise<void> | void;
  clear?: (serverId: string, ownerUserId: string) => Promise<void> | void;
}

/** 注入的 CatsCo 授权完成 grant（对齐 skillConnectorGrants 模式：短命 + 绑定 owner）。 */
export interface CatsCoOAuthGrant {
  serverId: string;
  ownerUserId: string;
  /** 授权码（auth code 流程）或直接下发的 access token。 */
  authorizationCode?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt: number;
  state?: string;
}

export interface CatsCoOAuthProviderOptions {
  serverId: string;
  /** token 归属的用户（= 设备/账号主人）。 */
  ownerUserId: string;
  /** MCP server 的回调地址（CatsCompany /api/mcp/oauth/callback 的公网地址）。 */
  redirectUrl?: string;
  catscoCallbackUrl?: string;
  /** 覆盖 client metadata（缺省 = 标准 public client + PKCE S256）。 */
  clientMetadata?: Partial<OAuthClientMetadata>;
  /** 预注册的 client information（有则跳过动态注册）。 */
  clientInformation?: OAuthClientInformationMixed;
  sendAuthorizationRequest?: SendOAuthAuthorizationRequest;
  tokenStore?: OAuthTokenStore;
  /** 等待用户授权的最长时间（默认 10 分钟）。 */
  authorizationTimeoutMs?: number;
  now?: () => number;
}

interface PendingAuthorization {
  state: string;
  authorizationUrl: string;
  resolve: (grant: CatsCoOAuthGrant) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  expiresAt: number;
}

const DEFAULT_AUTHORIZATION_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_REDIRECT_PATH = '/api/mcp/oauth/callback';

/**
 * 单 server + 单 owner 的 OAuthClientProvider。
 * SDK 的 StreamableHTTPClientTransport 拿到它之后自动完成 401 重试、step-up 与刷新。
 */
export class CatsCoMcpOAuthProvider {
  readonly serverId: string;
  readonly ownerUserId: string;
  private readonly redirectUrlValue?: string;
  private readonly catscoCallbackUrl?: string;
  private readonly metadata: OAuthClientMetadata;
  private readonly sendAuthorizationRequest?: SendOAuthAuthorizationRequest;
  private readonly tokenStore?: OAuthTokenStore;
  private readonly authorizationTimeoutMs: number;
  private readonly now: () => number;

  private clientInfo: OAuthClientInformationMixed | undefined;
  private tokensValue: OAuthTokens | undefined;
  private verifier: string | undefined;
  private readonly pendingAuthorizations = new Map<string, PendingAuthorization>();

  constructor(options: CatsCoOAuthProviderOptions) {
    this.serverId = options.serverId;
    this.ownerUserId = options.ownerUserId;
    this.redirectUrlValue = options.redirectUrl;
    this.catscoCallbackUrl = options.catscoCallbackUrl;
    this.sendAuthorizationRequest = options.sendAuthorizationRequest;
    this.tokenStore = options.tokenStore;
    this.authorizationTimeoutMs = options.authorizationTimeoutMs ?? DEFAULT_AUTHORIZATION_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.clientInfo = options.clientInformation;
    this.metadata = {
      redirect_uris: this.redirectUrlValue ? [this.redirectUrlValue] : [],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      client_name: `XiaoBa-CLI MCP client (${this.serverId})`,
      ...options.clientMetadata,
    } as OAuthClientMetadata;
  }

  // ---------- OAuthClientProvider 接口（结构兼容，不强 import sdk 类型以免版本耦合） ----------

  get redirectUrl(): string | undefined {
    return this.redirectUrlValue;
  }

  get clientMetadata(): OAuthClientMetadata {
    return this.metadata;
  }

  state(): string {
    return crypto.randomBytes(16).toString('base64url');
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return this.clientInfo;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    this.clientInfo = info;
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    if (this.tokensValue) return this.tokensValue;
    const loaded = await this.tokenStore?.load?.(this.serverId, this.ownerUserId);
    if (loaded) this.tokensValue = loaded;
    return loaded;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.tokensValue = tokens;
    try {
      await this.tokenStore?.save?.(this.serverId, this.ownerUserId, tokens);
    } catch (error: any) {
      Logger.warning(`OAuth token 持久化失败 (${this.serverId}): ${error?.message ?? error}`);
    }
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const state = authorizationUrl.searchParams.get('state') ?? '';
    const key = state || `pending-${crypto.randomUUID()}`;
    const expiresAt = this.now() + this.authorizationTimeoutMs;

    const request: OAuthAuthorizationRequest = {
      serverId: this.serverId,
      ownerUserId: this.ownerUserId,
      authorizationUrl: authorizationUrl.toString(),
      ...(this.catscoCallbackUrl ? { catscoCallbackUrl: this.catscoCallbackUrl } : {}),
      ...(state ? { state } : {}),
      expiresAt,
    };

    let delivered = false;
    if (this.sendAuthorizationRequest) {
      try {
        delivered = await this.sendAuthorizationRequest(request) === true;
      } catch (error: any) {
        Logger.warning(`OAuth 授权请求投递失败 (${this.serverId}): ${error?.message ?? error}`);
      }
    }

    const timer = setTimeout(() => {
      const pending = this.pendingAuthorizations.get(key);
      if (pending) {
        this.pendingAuthorizations.delete(key);
        pending.reject(new Error(`OAuth 授权超时（${Math.round(this.authorizationTimeoutMs / 60000)} 分钟未完成）`));
      }
    }, Math.max(1, this.authorizationTimeoutMs));
    (timer as { unref?: () => void }).unref?.();

    // 登记挂起授权：宿主在用户完成 CatsCo 授权后 injectAuthorizationGrant 唤醒。
    const completion = new Promise<void>((resolve, reject) => {
      this.pendingAuthorizations.set(key, {
        state,
        authorizationUrl: authorizationUrl.toString(),
        resolve: (grant) => {
          // code 注入路径：SDK auth() 的等待者靠 authorizationCode 参数走完交换，
          // 这里能做的是直接落 token（access token grant）或记录 code 供宿主交换。
          if (grant.accessToken) {
            void this.saveTokens({
              access_token: grant.accessToken,
              token_type: 'bearer',
              ...(grant.refreshToken ? { refresh_token: grant.refreshToken } : {}),
            } as OAuthTokens);
          }
          resolve();
        },
        reject,
        timer,
        expiresAt,
      });
    });

    if (!delivered) {
      // 无法投递授权请求时，授权链接仍有价值：让宿主至少有机会从日志/带外通道拿到。
      Logger.warning(`OAuth 授权请求未送达 (${this.serverId})，等待带外注入授权 grant`);
    }

    // 不在此阻塞：SDK transport 的 auth 编排只要求 redirectToAuthorization 完成启动。
    // 但 completion promise 的 reject 不能变 unhandled —— 挂一个空 catch。
    void completion.catch(() => {});
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.verifier = codeVerifier;
  }

  async codeVerifier(): Promise<string> {
    if (!this.verifier) throw new Error(`OAuth PKCE verifier 缺失 (${this.serverId})`);
    return this.verifier;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'all' || scope === 'tokens') {
      this.tokensValue = undefined;
      await this.tokenStore?.clear?.(this.serverId, this.ownerUserId);
    }
    if (scope === 'all' || scope === 'verifier') this.verifier = undefined;
    if (scope === 'all' || scope === 'client') this.clientInfo = undefined;
  }

  // ---------- CatsCo grant 注入（宿主侧 API） ----------

  /**
   * 宿主把平台回调拿到的短命 grant 注入。
   * 匹配条件：serverId + ownerUserId + state（如果 grant 带 state）+ 未过期。
   * 返回 true = 有挂起的授权被唤醒。
   */
  injectAuthorizationGrant(grant: CatsCoOAuthGrant, now = this.now()): boolean {
    if (grant.serverId !== this.serverId || grant.ownerUserId !== this.ownerUserId) return false;
    if (!Number.isFinite(grant.expiresAt) || grant.expiresAt <= now) return false;

    // 优先按 state 精确匹配；grant 无 state 时取最早创建的挂起授权。
    let key: string | undefined;
    if (grant.state && this.pendingAuthorizations.has(grant.state)) {
      key = grant.state;
    } else if (!grant.state) {
      key = [...this.pendingAuthorizations.entries()]
        .sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0]?.[0];
    }
    if (!key) return false;

    const pending = this.pendingAuthorizations.get(key);
    if (!pending) return false;
    this.pendingAuthorizations.delete(key);
    clearTimeout(pending.timer);
    try {
      pending.resolve(grant);
    } catch (error: any) {
      Logger.warning(`OAuth grant 注入处理失败 (${this.serverId}): ${error?.message ?? error}`);
      return false;
    }
    return true;
  }

  /** 等待中的授权数（诊断/测试用）。 */
  get pendingAuthorizationCount(): number {
    return this.pendingAuthorizations.size;
  }

  /** 进程收尾：拒绝全部挂起授权。 */
  dispose(): void {
    for (const pending of this.pendingAuthorizations.values()) {
      clearTimeout(pending.timer);
      try {
        pending.reject(new Error('OAuth provider disposed'));
      } catch { /* already settled */ }
    }
    this.pendingAuthorizations.clear();
  }
}

/** 便捷工厂：从 CatsCo 连接配置推导回调地址。 */
export function defaultCatsCoOAuthCallbackUrl(httpBaseUrl: string | undefined): string | undefined {
  const base = (httpBaseUrl ?? '').trim().replace(/\/+$/, '');
  return base ? `${base}${DEFAULT_REDIRECT_PATH}` : undefined;
}
