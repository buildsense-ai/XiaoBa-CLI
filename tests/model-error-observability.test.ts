import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  attachRetrySummary,
  captureModelErrorDiagnostics,
} from '../src/utils/model-error-observability';
import { classifyModelError } from '../src/utils/model-error-classifier';

const noKnownFlags = {
  isImageSafetyError: false,
  isRelayBudgetError: false,
  isVisionError: false,
  isTimeout: false,
  isEmptyResponse: false,
  isTransient: false,
};

describe('model error observability', () => {
  test('preserves structured provider evidence and retry provenance without leaking credentials', () => {
    const rawError = Object.assign(new Error('Request failed with status code 400'), {
      response: {
        status: 400,
        headers: { 'x-request-id': 'req_header_fallback' },
        data: {
          request_id: 'req_body_123',
          error: {
            code: 'invalid_request_error',
            type: 'invalid_request_error',
            message: 'tool schema invalid for key sk-secret-value-123456',
          },
        },
      },
    });
    attachRetrySummary(rawError, {
      attempt_count: 3,
      retry_count: 2,
      max_retries: 2,
      elapsed_ms: 3210,
      max_elapsed_ms: 15000,
      stop_reason: 'retry_limit_exhausted',
    }, {
      call_id: 'call-123',
      attempt_id: 'call-123:3',
      attempt_number: 3,
      episode_id: 'episode-456',
    });

    const diagnostics = captureModelErrorDiagnostics(rawError, {
      provider: 'openai',
      model: 'deepseek-v4-flash',
      phase: 'model_request',
    });

    assert.equal(diagnostics.http_status, 400);
    assert.equal(diagnostics.provider_code, 'invalid_request_error');
    assert.equal(diagnostics.provider_type, 'invalid_request_error');
    assert.match(diagnostics.request_id || '', /^request_[a-f0-9]{12}$/);
    assert.notEqual(diagnostics.request_id, 'req_body_123');
    assert.equal(diagnostics.origin, 'provider');
    assert.equal(diagnostics.retry?.attempt_count, 3);
    assert.equal(diagnostics.retry?.retry_count, 2);
    assert.equal(diagnostics.retry?.stop_reason, 'retry_limit_exhausted');
    assert.deepStrictEqual(diagnostics.attempt, {
      call_id: 'call-123',
      attempt_id: 'call-123:3',
      attempt_number: 3,
      episode_id: 'episode-456',
    });
    assert.match(diagnostics.error_summary, /signal_request_invalid/);
    assert.doesNotMatch(diagnostics.error_summary, /secret-value|tool schema invalid/);
    assert.match(diagnostics.fingerprint, /^[a-f0-9]{16}$/);
  });

  test('captures a safe local stack location for runtime failures', () => {
    const diagnostics = captureModelErrorDiagnostics(
      new TypeError("Cannot read properties of undefined (reading 'run_id')"),
      { phase: 'agent_turn' },
    );

    assert.equal(diagnostics.origin, 'runtime');
    assert.match(diagnostics.top_frame || '', /tests\/model-error-observability\.test\.ts/);
    assert.doesNotMatch(diagnostics.top_frame || '', /\/Users\/|\/tmp\//);
    assert.match(diagnostics.stack_fingerprint || '', /^[a-f0-9]{16}$/);
  });

  test('classifies bare 400 and 403 as low-confidence provider rejection', () => {
    for (const status of [400, 403]) {
      const classified = classifyModelError(
        Object.assign(new Error(`Request failed with status code ${status}`), { status }),
        noKnownFlags,
        { provider: 'openai', model: 'test-model', phase: 'model_request' },
      );
      assert.equal(classified.category, 'provider_rejected');
      assert.equal(classified.error_code, `provider_rejected_${status}`);
      assert.equal(classified.confidence, 'low');
      assert.equal(classified.recovery_action, 'retry_later');
    }
  });

  test('uses explicit provider evidence for high-confidence causes', () => {
    const permissionError = Object.assign(new Error('Request failed with status code 403'), {
      response: {
        status: 403,
        data: { error: { code: 'permission_denied', message: 'permission denied for this model' } },
      },
    });
    const permission = classifyModelError(permissionError, noKnownFlags);
    assert.equal(permission.category, 'access_denied');
    assert.equal(permission.confidence, 'high');
    assert.equal(permission.recovery_action, 'fix_configuration');

    const replay = classifyModelError(
      new Error('reasoning_content must be passed back in the next assistant message'),
      noKnownFlags,
    );
    assert.equal(replay.category, 'reasoning_replay_required');
    assert.equal(replay.retry_strategy, 'fix_and_retry_once');
    assert.equal(replay.recovery_action, 'repair_session');
  });
  test('does not log free-form provider fields, request ids, credentials, or echoed user text', () => {
    const diagnostics = captureModelErrorDiagnostics(Object.assign(new Error('echoed user text: my private medical note'), {
      response: {
        status: 400,
        data: {
          request_id: 'req-private-user-123',
          error: {
            code: 'sk-secret-value-123456 echoed user text',
            type: 'credential=super-secret echoed user text',
            message: 'invalid request: echoed user text: my private medical note',
          },
        },
      },
    }));
    assert.equal(diagnostics.provider_code, undefined);
    assert.equal(diagnostics.provider_type, undefined);
    assert.match(diagnostics.request_id || '', /^request_[a-f0-9]{12}$/);
    assert.match(diagnostics.error_summary, /http_400/);
    assert.match(diagnostics.error_summary, /signal_request_invalid/);
    assert.doesNotMatch(JSON.stringify(diagnostics), /private medical note|super-secret|sk-secret-value|req-private-user-123/);
  });

  test('does not execute throwing error getters while capturing diagnostics', () => {
    const hostile = new Proxy(Object.freeze({}), {
      get(_target, property) {
        if (property === 'message' || property === 'response' || property === 'cause') {
          throw new Error('getter should not escape diagnostics');
        }
        return undefined;
      },
      getPrototypeOf() { throw new Error('prototype access should not escape diagnostics'); },
    });
    const diagnostics = captureModelErrorDiagnostics(hostile, { phase: 'agent_turn' });
    assert.equal(diagnostics.origin, 'runtime');
    assert.equal(typeof diagnostics.error_summary, 'string');
    assert.match(diagnostics.fingerprint, /^[a-f0-9]{16}$/);
  });

  test('classifies the safe cause carried by a partial-turn wrapper', () => {
    const cause = Object.assign(new Error('API错误 (504): request timed out'), { status: 504 });
    const wrapped = new Error(cause.message);
    Object.defineProperty(wrapped, 'cause', { value: cause, enumerable: false });
    const classified = classifyModelError(wrapped, { ...noKnownFlags, isTimeout: true });
    assert.equal(classified.category, 'timeout');
    assert.equal(classified.diagnostics.http_status, 504);
  });

});
