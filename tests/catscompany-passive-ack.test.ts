import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { isCatsCompanyPassiveAcknowledgement } from '../src/catscompany';

describe('CatsCompany passive acknowledgement classifier', () => {
  test('matches short acknowledgements and thanks', () => {
    for (const text of ['嗯嗯', '收到', '谢谢', '收到，谢谢', '辛苦了', 'thanks']) {
      assert.equal(isCatsCompanyPassiveAcknowledgement(text), true, text);
    }
  });

  test('does not match actionable messages', () => {
    for (const text of ['好', '好的', '可以', '行', 'ok', '好的，继续帮我看', '谢谢，顺便重启一下', '可以吗？', 'ok 帮我改一下', '这个为什么不行']) {
      assert.equal(isCatsCompanyPassiveAcknowledgement(text), false, text);
    }
  });
});
