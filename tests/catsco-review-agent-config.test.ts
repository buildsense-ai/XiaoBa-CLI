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
          'CATSCO_REVIEW_MAX_TARGET_TURNS=123',
          'CATSCO_REVIEW_TARGET_USER_ID=catsco_116',
          'CATSCO_REVIEW_TARGET_DEVICE_ID=device-raw',
          'CATSCO_REVIEW_TARGET_DEVICE_NAME=教务处电脑',
          'CATSCO_REVIEW_TARGET_BOT_ID=bot-raw',
          'CATSCO_REVIEW_TARGET_PERSON_ID=person-raw',
          'CATSCO_REVIEW_TARGET_ACTOR_EXTERNAL_USER_ID=actor-external-raw',
          'CATSCO_REVIEW_TARGET_ACTOR_CATSCO_USER_ID=actor-catsco-raw',
          'CATSCO_REVIEW_TARGET_ACTOR_WEIXIN_USER_ID=actor-weixin-raw',
          'CATSCO_REVIEW_TARGET_ACTOR_FEISHU_USER_ID=actor-feishu-raw',
          'CATSCO_REVIEW_TARGET_USER_KEY=user-a',
          'CATSCO_REVIEW_TARGET_DEVICE_KEY=device-a',
          'CATSCO_REVIEW_TARGET_BOT_KEY=bot-a',
          'CATSCO_REVIEW_TARGET_PERSON_KEY=person-a',
          'CATSCO_REVIEW_TARGET_ACTOR_KEY=actor-a',
          'CATSCO_REVIEW_TARGET_ACTOR_CATSCO_USER_KEY=actor-catsco-a',
          'CATSCO_REVIEW_TARGET_ACTOR_WEIXIN_USER_KEY=actor-weixin-a',
          'CATSCO_REVIEW_TARGET_ACTOR_FEISHU_USER_KEY=actor-feishu-a',
          'CATSCO_REVIEW_TARGET_SESSION_ID=session-raw',
          'CATSCO_REVIEW_TARGET_SESSION_KEY=session-a',
          'CATSCO_REVIEW_TARGET_SESSION_TYPE=chat',
          'CATSCO_REVIEW_TARGET_ORG_KEY=school-a',
          'CATSCO_REVIEW_TARGET_ORG_TYPE=school',
          'CATSCO_REVIEW_TARGET_USER_ROLE=teacher',
          'CATSCO_REVIEW_TARGET_DEVICE_ROLE=office',
          'CATSCO_REVIEW_TARGET_CHANNEL_TYPE=desktop',
          'CATSCO_REVIEW_TARGET_WORKSPACE_KEY=workspace-a',
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
      assert.equal(config.maxTargetTurns, 123);
      assert.equal(config.targetUserId, 'catsco_116');
      assert.equal(config.targetDeviceId, 'device-raw');
      assert.equal(config.targetDeviceName, '教务处电脑');
      assert.equal(config.targetBotId, 'bot-raw');
      assert.equal(config.targetPersonId, 'person-raw');
      assert.equal(config.targetActorExternalUserId, 'actor-external-raw');
      assert.equal(config.targetActorCatscoUserId, 'actor-catsco-raw');
      assert.equal(config.targetActorWeixinUserId, 'actor-weixin-raw');
      assert.equal(config.targetActorFeishuUserId, 'actor-feishu-raw');
      assert.equal(config.targetUserKey, 'user-a');
      assert.equal(config.targetDeviceKey, 'device-a');
      assert.equal(config.targetBotKey, 'bot-a');
      assert.equal(config.targetPersonKey, 'person-a');
      assert.equal(config.targetActorKey, 'actor-a');
      assert.equal(config.targetActorCatscoUserKey, 'actor-catsco-a');
      assert.equal(config.targetActorWeixinUserKey, 'actor-weixin-a');
      assert.equal(config.targetActorFeishuUserKey, 'actor-feishu-a');
      assert.equal(config.targetSessionId, 'session-raw');
      assert.equal(config.targetSessionKey, 'session-a');
      assert.equal(config.targetSessionType, 'chat');
      assert.equal(config.targetOrgKey, 'school-a');
      assert.equal(config.targetOrgType, 'school');
      assert.equal(config.targetUserRole, 'teacher');
      assert.equal(config.targetDeviceRole, 'office');
      assert.equal(config.targetChannelType, 'desktop');
      assert.equal(config.targetWorkspaceKey, 'workspace-a');
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

  test('uses one week as the default review lookback', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-review-config-'));
    try {
      const config = getCatscoReviewAgentConfig(root, {
        CATSCO_REVIEW_TOKEN: 'review-token',
      });
      assert.equal(config.lookbackHours, 168);
      assert.doesNotThrow(() => validateCatscoReviewAgentConfig(config));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
