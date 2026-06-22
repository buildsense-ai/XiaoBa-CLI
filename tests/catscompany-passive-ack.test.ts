import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { isCatsCompanyPassiveAcknowledgement } from '../src/catscompany';

describe('CatsCompany passive acknowledgement classifier', () => {
  test('matches short acknowledgements and thanks', () => {
    for (const text of ['好', '好的', '嗯嗯', '收到', '谢谢', '好的，谢谢', 'ok thanks', '辛苦了']) {
      assert.equal(isCatsCompanyPassiveAcknowledgement(text), true, text);
    }
  });

  test('does not match actionable messages', () => {
    for (const text of ['好的，继续帮我看', '谢谢，顺便重启一下', '可以吗？', 'ok 帮我改一下', '这个为什么不行']) {
      assert.equal(isCatsCompanyPassiveAcknowledgement(text), false, text);
    }
  });
});
