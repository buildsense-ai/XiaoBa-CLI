import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { redactReviewText } from '../src/utils/catsco-review-redaction';

describe('catsco review redaction', () => {
  test('redacts review secrets, school identifiers, urls, and paths with spaces', () => {
    const redacted = redactReviewText([
      'Bearer catslog_review_secret123',
      '邮箱 teacher@example.com 手机 13812345678',
      '学生姓名 张三 学号: 2024012345 身份证 110101199003071234',
      '微信 wxid_abcdef QQ: 12345678',
      '路径 E:\\Dirty Work\\XiaoBa-CLI\\server\\log.txt',
      'UNC \\\\server\\share name\\folder\\file.txt',
      'URL https://logs.catsco.fun:8000/private?a=1',
      'user_id=catsco_116 device_id=device-raw device_name=教务处电脑 session_id=session-raw',
      'bot_id=bot-raw person_id=person-raw actor_external_user_id=actor-external actor_weixin_user_id=wx-raw',
      'from_user_id=from-raw to_user_id=to-raw raw_actor_id=actor-raw',
      '{"user_id":"catsco_117","device_name":"老师电脑","session_id":"session-json","actor_catsco_user_id":"catsco-platform-raw"}',
    ].join('\n'));

    assert.match(redacted, /Bearer \[REDACTED\]/);
    assert.match(redacted, /\[EMAIL_REDACTED\]/);
    assert.match(redacted, /\[PHONE_REDACTED\]/);
    assert.match(redacted, /\[NAME_REDACTED\]/);
    assert.match(redacted, /\[ID_REDACTED\]/);
    assert.match(redacted, /\[CONTACT_REDACTED\]/);
    assert.match(redacted, /\[PATH_REDACTED\]/);
    assert.match(redacted, /\[URL_REDACTED\]/);
    assert.match(redacted, /\[RAW_ID_REDACTED\]/);
    assert.doesNotMatch(redacted, /Dirty Work/);
    assert.doesNotMatch(redacted, /teacher@example\.com/);
    assert.doesNotMatch(redacted, /110101199003071234/);
    assert.doesNotMatch(redacted, /catsco_116/);
    assert.doesNotMatch(redacted, /教务处电脑/);
    assert.doesNotMatch(redacted, /session-json/);
    assert.doesNotMatch(redacted, /bot-raw|person-raw|actor-external|wx-raw|from-raw|to-raw|catsco-platform-raw/);
  });
});
