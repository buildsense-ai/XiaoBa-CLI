import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getCatscoReviewAgentConfig,
  validateCatscoReviewAgentConfig,
} from '../src/utils/catsco-review-agent-config';

describe('catsco review agent config', () => {
  test('reads dotenv values and validates secure base URL', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-review-config-'));
    try {
      fs.writeFileSync(
        path.join(root, '.env'),
        [
          'CATSCO_REVIEW_API_BASE_URL=http://127.0.0.1:18080',
          'CATSCO_REVIEW_TOKEN=review-token',
          'CATSCO_REVIEW_TARGET_REPO=.',
          'CATSCO_REVIEW_LOOKBACK_HOURS=12',
          'CATSCO_REVIEW_INTERVAL_MINUTES=30',
          'CATSCO_REVIEW_CREATE_BRANCH=true',
          '',
        ].join('\n'),
        'utf-8',
      );

      const config = getCatscoReviewAgentConfig(root, {});
      assert.equal(config.apiBaseUrl, 'http://127.0.0.1:18080');
      assert.equal(config.reviewToken, 'review-token');
      assert.equal(config.lookbackHours, 12);
      assert.equal(config.intervalMinutes, 30);
      assert.equal(config.createBranch, true);
      assert.equal(config.targetRepo, root);
      assert.doesNotThrow(() => validateCatscoReviewAgentConfig(config));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects insecure non-local review API URL and missing token', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-review-config-'));
    try {
      const config = getCatscoReviewAgentConfig(root, {
        CATSCO_REVIEW_API_BASE_URL: 'http://logs.example.test:8000',
      });
      assert.equal(config.apiBaseUrl, '');
      assert.throws(() => validateCatscoReviewAgentConfig(config), /CATSCO_REVIEW_API_BASE_URL/);
      assert.throws(() => validateCatscoReviewAgentConfig(config), /CATSCO_REVIEW_TOKEN/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
