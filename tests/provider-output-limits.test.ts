import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMaxTokens } from '../src/providers/output-limits';

test('resolveMaxTokens prefers explicit config value over relay defaults', () => {
  assert.equal(
    resolveMaxTokens({
      apiUrl: 'https://relay.catsco.cc/anthropic/v1/messages',
      model: 'MiniMax-M2.7',
      maxTokens: 12345,
    }),
    12345,
  );
});

test('resolveMaxTokens uses higher default for CatsCo relay and MiniMax M2.7', () => {
  assert.equal(
    resolveMaxTokens({
      apiUrl: 'https://relay.catsco.cc/v1/chat/completions',
      model: 'other-model',
    }),
    32768,
  );
  assert.equal(
    resolveMaxTokens({
      apiUrl: 'https://example.test/v1/chat/completions',
      model: 'MiniMax-M2.7',
    }),
    32768,
  );
  assert.equal(
    resolveMaxTokens({
      apiUrl: 'https://example.test/v1/chat/completions',
      model: 'MiniMax-M3',
    }),
    32768,
  );
});

test('resolveMaxTokens keeps the conservative default for other providers', () => {
  assert.equal(
    resolveMaxTokens({
      apiUrl: 'https://api.openai.com/v1/chat/completions',
      model: 'gpt-4o',
    }),
    8192,
  );
});

test('resolveMaxTokens clamps output to a quarter of explicit context windows', () => {
  assert.equal(
    resolveMaxTokens({
      apiUrl: 'https://custom.example.test/anthropic',
      model: 'tiny-window',
      maxTokens: 8192,
      contextWindowTokens: 1024,
    }),
    256,
  );
  assert.equal(
    resolveMaxTokens({
      apiUrl: 'https://relay.catsco.cc/anthropic',
      model: 'MiniMax-M3',
      contextWindowTokens: 1_000_000,
    }),
    32768,
  );
});
