export const MODEL_IMAGE_SAFETY_MESSAGE =
  '模型拒绝了当前对话里的某张图片，可能触发了上游图片安全策略。本轮已停止；请删除或更换这张图片，或新开对话后继续。';

export function isModelImageSafetyError(error: unknown): boolean {
  const text = String(
    error instanceof Error ? error.message : error ?? '',
  );

  const hasSafetyCode = /input[\s_-]*new[\s_-]*sensitive/i.test(text)
    || /sensitive/i.test(text);
  const hasImageEvidence = /image\s+is\s+sensitive/i.test(text)
    || /content\[\d+\][^{}]{0,120}image[^{}]{0,120}sensitive/i.test(text)
    || /messages\[\d+\][^{}]{0,180}content\[\d+\][^{}]{0,180}image/i.test(text);

  return hasSafetyCode && hasImageEvidence;
}

// ─── 结构化模型错误分类 ──────────────────────────────────
// 供 agent-session（用户提示 + 结构化日志）与重试策略共同使用，
// 避免「重试层知道是额度/鉴权，提示层却只说未预期错误」的脱节。

export type ModelErrorCategory =
  | 'image_safety'
  | 'budget'
  | 'vision_unsupported'
  | 'timeout'
  | 'empty_response'
  | 'transient'
  | 'auth_invalid'
  | 'access_denied'
  | 'model_or_endpoint_missing'
  | 'input_too_large'
  | 'request_invalid'
  | 'reasoning_replay_required'
  | 'unexpected';

export type ModelErrorRetryStrategy =
  | 'none'
  | 'transport'
  | 'fix_and_retry_once';

export interface ModelErrorClassification {
  error_code: string;
  category: ModelErrorCategory;
  http_status: number | null;
  user_message: string;
  /** 建议恢复策略；传输层重试仍由 AIService 的 withRetry 决定 */
  retry_strategy: ModelErrorRetryStrategy;
}

export const MODEL_ERROR_MESSAGE_DEFAULTS: Record<ModelErrorCategory, string> = {
  image_safety: MODEL_IMAGE_SAFETY_MESSAGE,
  budget: '当前模型的额度不足，暂时无法继续调用。请补充额度或切换到其他模型后再试。',
  vision_unsupported: '当前模型不支持图片识别。请使用支持多模态的模型，或者用文字描述图片内容。',
  timeout: '模型中转请求超时了，我已经保留本轮已完成的工具结果和上下文。你可以直接说“继续”，我会从这里接上。',
  empty_response: '模型本轮未返回有效内容，自动重试后仍未恢复。请重新发送上一条消息；若仍失败，请切换模型或稍后再试。',
  transient: '当前模型服务临时异常，刚才这次请求没有完成。我已经保留上下文；你可以稍后重试，或临时切换到其他模型继续。',
  auth_invalid: '当前模型的访问凭证无效或已过期，暂时无法调用。请更新模型配置后重试。',
  access_denied: '当前账号没有调用这个模型的权限，暂时无法继续。请检查账号权限或切换到已授权模型。',
  model_or_endpoint_missing: '当前模型或接口配置不存在，无法继续。请检查模型名称和接口地址，或切换模型。',
  input_too_large: '这轮对话内容超过当前模型可接受的大小。我会先压缩较早内容后重试；若仍失败，请缩小请求范围或切换上下文更大的模型。',
  request_invalid: '模型拒绝了本轮请求格式。问题已记录；这不是反复重试能解决的，请稍后重新发送，或切换模型后再试。',
  reasoning_replay_required: '模型的推理上下文同步出现问题，正在恢复后重试。',
  unexpected: '当前请求遇到一个未预期的错误，我已保留上下文。你可以直接再试一次；如果持续失败，建议临时切换到其他模型。',
};

function extractHttpStatus(error: any): number | null {
  const status = error?.status || error?.response?.status || error?.error?.status;
  if (typeof status === 'number') return status;
  const text = String(error?.message || error || '');
  const match = text.match(/(?:API错误|HTTP|status(?:\s*code)?)\s*[\(:= ]\s*(\d{3})\b/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildUnexpected(error: any, httpStatus: number | null): ModelErrorClassification {
  const suffix = httpStatus ? `_${httpStatus}` : '';
  return {
    error_code: `unexpected${suffix}`,
    category: 'unexpected',
    http_status: httpStatus,
    user_message: MODEL_ERROR_MESSAGE_DEFAULTS.unexpected,
    retry_strategy: 'none',
  };
}

export interface KnownErrorFlags {
  isImageSafetyError: boolean;
  isRelayBudgetError: boolean;
  isVisionError: boolean;
  isTimeout: boolean;
  isEmptyResponse: boolean;
  isTransient: boolean;
}

/**
 * 统一模型错误分类。先识别已有六类已知错误，再对 4xx/未命中项做语义细分。
 * known 参数由调用方（agent-session）按现有判断链计算，保持行为一致。
 */
export function classifyModelError(
  error: any,
  known: KnownErrorFlags,
): ModelErrorClassification {
  const httpStatus = extractHttpStatus(error);
  const text = String(error?.message || error || '');

  const base = (category: ModelErrorCategory, errorCode: string, retry: ModelErrorRetryStrategy): ModelErrorClassification => ({
    error_code: errorCode,
    category,
    http_status: httpStatus,
    user_message: MODEL_ERROR_MESSAGE_DEFAULTS[category],
    retry_strategy: retry,
  });

  if (known.isImageSafetyError) return base('image_safety', 'image_safety_block', 'none');
  if (known.isRelayBudgetError) return base('budget', 'relay_budget_exhausted', 'none');
  if (known.isVisionError) return base('vision_unsupported', 'vision_not_supported', 'none');
  if (known.isTimeout) return base('timeout', 'model_timeout', 'transport');
  if (known.isEmptyResponse) return base('empty_response', 'empty_model_response', 'transport');
  if (known.isTransient) return base('transient', 'transient_provider_error', 'transport');

  // ─── 4xx 语义细分 ──────────────────────────────────────
  if (httpStatus === 401
    || /invalid[_\s-]?api[_\s-]?key|unauthorized|authentication failed|authentication error/i.test(text)) {
    return base('auth_invalid', 'auth_invalid', 'none');
  }

  if (httpStatus === 403
    || /forbidden|permission denied|access denied|not authorized/i.test(text)) {
    return base('access_denied', 'access_denied', 'none');
  }

  if (httpStatus === 404
    || /model[_\s-]?not[_\s-]?found|endpoint[_\s-]?not[_\s-]?found|not found/i.test(text)) {
    return base('model_or_endpoint_missing', 'model_or_endpoint_missing', 'none');
  }

  // DeepSeek thinking mode 必须在下一轮回传 reasoning_content
  if (/reasoning[_\s-]?content.{0,60}(must be passed back|must be echoed|not passed back|expected)/i.test(text)
    || /thinking mode.{0,60}reasoning/i.test(text)) {
    return base('reasoning_replay_required', 'reasoning_replay_required', 'fix_and_retry_once');
  }

  if (httpStatus === 413
    || /context length|maximum context|context window|max(?:imum)? tokens?|prompt too long|token limit|too many tokens/i.test(text)) {
    return base('input_too_large', 'input_too_large', 'fix_and_retry_once');
  }

  if (httpStatus === 422
    || /invalid[_\s-]?request|tool schema|schema is invalid|invalid parameter|invalid input|bad request|malformed|invalid json/i.test(text)) {
    return base('request_invalid', 'request_invalid', 'none');
  }

  // 400 兜底：只有错误文本明确指向请求格式问题时才归为不可重试。
  // 裸 400（如 axios 默认的 "Request failed with status code 400"）大多是
  // 上游瞬态或 reasoning 回传问题，重试/说"继续"即可恢复，不能宣称不可重试。
  if (httpStatus === 400) {
    if (/invalid[_\s-]?request|bad request|invalid (?:parameter|input|argument)|schema is invalid|tool schema|malformed|invalid json|unexpected token/i.test(text)) {
      return base('request_invalid', 'request_invalid', 'none');
    }
    return buildUnexpected(error, httpStatus);
  }

  return buildUnexpected(error, httpStatus);
}
