import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyProviderErrorForLog,
  formatProviderErrorForLog,
  sanitizeProviderErrorMessageForLog,
} from '../src/utils/provider-error-log-sanitizer';

test('provider error log sanitizer redacts secrets and network details', () => {
  const error = new Error(
    'anthropic: MaxRetriesExceededError: HTTPSConnectionPool(host=api.anthropic.com, host=\'173.252.107.94\', port=443). '
    + 'Max retries exceeded with url: https://api.anthropic.com/v1/messages?api_key=super-secret '
    + 'Authorization: Bearer sk-provider-secret-token and x_api_key=another-secret '
    + 'request body contains sk-bf-1234567890abcdef',
  );

  const sanitized = sanitizeProviderErrorMessageForLog(error);

  assert.match(sanitized, /host=\[redacted-host\]/);
  assert.match(sanitized, /\[redacted-url\]/);
  assert.match(sanitized, /Authorization: \[redacted-token\]/);
  assert.doesNotMatch(sanitized, /api\.anthropic\.com/);
  assert.doesNotMatch(sanitized, /173\.252\.107\.94/);
  assert.doesNotMatch(sanitized, /super-secret/);
  assert.doesNotMatch(sanitized, /sk-provider-secret-token/);
  assert.doesNotMatch(sanitized, /sk-bf-1234567890abcdef/);
});

test('provider error formatter returns a compact classified summary', () => {
  const formatted = formatProviderErrorForLog({
    status: 500,
    error: {
      type: 'api_error',
      code: 'invalid_request_error',
      message: 'input_new_sensitive, messages[86] content[3] image is sensitive, please check your input',
    },
  });

  assert.match(formatted, /category=model_image_safety/);
  assert.match(formatted, /status=500/);
  assert.match(formatted, /type=api_error/);
  assert.match(formatted, /code=invalid_request_error/);
  assert.equal(classifyProviderErrorForLog(new Error('Connection error. ECONNRESET')), 'provider_connection');
});
