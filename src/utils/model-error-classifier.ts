import {
  captureModelErrorDiagnostics,
  type ModelErrorDiagnostics,
  type ModelErrorPhase,
} from './model-error-observability';

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

export type ModelErrorCategory =
  | 'image_safety'
  | 'budget'
  | 'vision_unsupported'
  | 'timeout'
  | 'empty_response'
  | 'transient'
  | 'rate_limited'
  | 'auth_invalid'
  | 'access_denied'
  | 'model_or_endpoint_missing'
  | 'input_too_large'
  | 'request_invalid'
  | 'reasoning_replay_required'
  | 'provider_rejected'
  | 'unexpected';

export type ModelErrorRetryStrategy = 'none' | 'transport' | 'fix_and_retry_once';
export type ModelErrorConfidence = 'high' | 'medium' | 'low';
export type ModelErrorRecoveryAction =
  | 'retry_later'
  | 'retry_same_context'
  | 'switch_model'
  | 'fix_configuration'
  | 'reduce_input'
  | 'repair_session'
  | 'investigate';

export interface ModelErrorClassification {
  error_code: string;
  category: ModelErrorCategory;
  confidence: ModelErrorConfidence;
  user_message: string;
  retry_strategy: ModelErrorRetryStrategy;
  recovery_action: ModelErrorRecoveryAction;
  diagnostics: ModelErrorDiagnostics;
}

export interface KnownModelErrorFlags {
  isImageSafetyError: boolean;
  isRelayBudgetError: boolean;
  isVisionError: boolean;
  isTimeout: boolean;
  isEmptyResponse: boolean;
  isTransient: boolean;
}

export interface ModelErrorClassificationContext {
  provider?: string;
  model?: string;
  phase?: ModelErrorPhase;
}

const USER_MESSAGES: Record<ModelErrorCategory, string> = {
  image_safety: MODEL_IMAGE_SAFETY_MESSAGE,
  budget: '当前模型的额度不足，暂时无法继续调用。请补充额度或切换到其他模型后再试。',
  vision_unsupported: '当前模型不支持图片识别。请使用支持多模态的模型，或者用文字描述图片内容。',
  timeout: '模型中转请求超时了，我已经保留本轮已完成的工具结果和上下文。你可以直接说“继续”，我会从这里接上。',
  empty_response: '模型本轮未返回有效内容，自动重试后仍未恢复。请重新发送上一条消息；若仍失败，请切换模型或稍后再试。',
  transient: '当前模型服务临时异常，刚才这次请求没有完成。我已经保留上下文；你可以稍后重试，或临时切换到其他模型继续。',
  rate_limited: '当前模型请求过于频繁，暂时无法继续。请稍后重试，或临时切换到其他模型。',
  auth_invalid: '当前模型的访问凭证无效或已过期。请更新模型配置后重试。',
  access_denied: '当前账号没有调用这个模型的权限。请检查账号权限或切换到已授权模型。',
  model_or_endpoint_missing: '当前模型或接口配置不存在。请检查模型名称和接口地址，或切换模型。',
  input_too_large: '这轮内容超过当前模型可接受的大小。请缩小请求范围、清理较早上下文，或切换上下文更大的模型。',
  request_invalid: '模型拒绝了本轮请求格式。问题已记录；原样重试通常无法解决，请重新发送或切换模型。',
  reasoning_replay_required: '模型的推理上下文结构不完整。问题已记录，请重新发送；如果持续出现，请切换模型。',
  provider_rejected: '上游模型拒绝了本轮请求，但没有返回足够的原因。问题已记录；你可以再试一次，持续失败时请切换模型。',
  unexpected: '当前请求遇到未识别的异常，我已保留上下文并记录诊断信息。你可以再试一次；持续失败时请切换模型。',
};

/**
 * Classifies only evidence that survived the provider/retry boundary.
 * A bare 400/403 is deliberately called provider_rejected with low confidence;
 * the status alone is not enough to claim a malformed request or permission issue.
 */
export function classifyModelError(
  error: any,
  known: KnownModelErrorFlags,
  context: ModelErrorClassificationContext = {},
): ModelErrorClassification {
  const diagnostics = captureModelErrorDiagnostics(error, context);
  const status = diagnostics.http_status;
  const evidence = [
    diagnostics.provider_code,
    diagnostics.provider_type,
    diagnostics.error_summary,
  ].filter(Boolean).join(' ');

  const result = (
    category: ModelErrorCategory,
    errorCode: string,
    confidence: ModelErrorConfidence,
    retryStrategy: ModelErrorRetryStrategy,
    recoveryAction: ModelErrorRecoveryAction,
  ): ModelErrorClassification => ({
    error_code: errorCode,
    category,
    confidence,
    user_message: USER_MESSAGES[category],
    retry_strategy: retryStrategy,
    recovery_action: recoveryAction,
    diagnostics,
  });

  if (known.isImageSafetyError) return result('image_safety', 'image_safety_block', 'high', 'none', 'investigate');
  if (known.isRelayBudgetError) return result('budget', 'relay_budget_exhausted', 'high', 'none', 'switch_model');
  if (known.isVisionError) return result('vision_unsupported', 'vision_not_supported', 'medium', 'none', 'switch_model');
  if (known.isTimeout) return result('timeout', 'model_timeout', 'high', 'transport', 'retry_same_context');
  if (known.isEmptyResponse) return result('empty_response', 'empty_model_response', 'high', 'transport', 'retry_same_context');
  if (known.isTransient) return result('transient', 'transient_provider_error', 'high', 'transport', 'retry_later');

  if (/reasoning[_\s-]?(?:content|text).{0,80}(must be passed back|must be echoed|not passed back|required|expected)/i.test(evidence)
    || /thinking mode.{0,80}reasoning/i.test(evidence)) {
    return result('reasoning_replay_required', 'reasoning_replay_required', 'high', 'fix_and_retry_once', 'repair_session');
  }

  if (status === 401
    || /invalid[_\s-]?api[_\s-]?key|unauthorized|authentication (?:failed|error)|invalid[_\s-]?token/i.test(evidence)) {
    return result('auth_invalid', 'auth_invalid', 'high', 'none', 'fix_configuration');
  }

  if (/forbidden|permission denied|access denied|not authorized|insufficient[_\s-]?permissions?/i.test(evidence)) {
    return result('access_denied', 'access_denied', 'high', 'none', 'fix_configuration');
  }

  if (status === 404
    || /model[_\s-]?not[_\s-]?found|endpoint[_\s-]?not[_\s-]?found|unknown model|no such model/i.test(evidence)) {
    return result('model_or_endpoint_missing', 'model_or_endpoint_missing', 'high', 'none', 'fix_configuration');
  }

  if (status === 413
    || /context length|maximum context|context window|prompt too long|token limit|too many tokens/i.test(evidence)) {
    return result('input_too_large', 'input_too_large', 'high', 'fix_and_retry_once', 'reduce_input');
  }

  if (status === 429 || /rate limit|too many requests/i.test(evidence)) {
    return result('rate_limited', 'provider_rate_limited', 'high', 'transport', 'retry_later');
  }

  if (status === 422
    || /invalid[_\s-]?request|tool schema|schema is invalid|invalid (?:parameter|input|argument)|malformed|invalid json/i.test(evidence)) {
    return result('request_invalid', 'request_invalid', 'high', 'none', 'investigate');
  }

  if (status === 400 || status === 403) {
    return result('provider_rejected', `provider_rejected_${status}`, 'low', 'transport', 'retry_later');
  }

  return result(
    'unexpected',
    status ? `unexpected_${status}` : 'unexpected',
    'low',
    'none',
    'investigate',
  );
}
