import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicProvider } from '../src/providers/anthropic-provider';
import { Message } from '../src/types';
import type { ToolDefinition } from '../src/types/tool';

function createProvider(apiUrl = 'https://api.anthropic.com/v1/messages'): AnthropicProvider {
  return new AnthropicProvider({
    apiKey: 'test-key',
    apiUrl,
    model: 'claude-sonnet-4-20250514',
  });
}

function nativeMessages(dynamic: string): Message[] {
  return [
    { role: 'system', content: 'Stable policy.' },
    { role: 'system', content: dynamic },
    { role: 'user', content: 'Latest query' },
  ];
}

describe('AnthropicProvider prompt caching', () => {
  test('places a cache breakpoint after the stable system prefix on native Anthropic', () => {
    const provider = createProvider();
    const transformed = (provider as any).transformMessages(nativeMessages(
      '[transient_plan_status]\n1. [in_progress] inspect provider',
    ));

    assert.deepEqual(transformed.system, [
      {
        type: 'text',
        text: 'Stable policy.',
        cache_control: { type: 'ephemeral' },
      },
      {
        type: 'text',
        text: '[transient_plan_status]\n1. [in_progress] inspect provider',
      },
    ]);
    assert.deepEqual(transformed.messages, [{
      role: 'user',
      content: [{
        type: 'text',
        text: 'Latest query',
        cache_control: { type: 'ephemeral' },
      }],
    }]);
  });

  test('keeps the cached system block stable when plan and subagent state changes', () => {
    const provider = createProvider();
    const variants = [
      '[transient_plan_status]\n1. [pending] inspect provider',
      '[transient_plan_status]\n1. [completed] inspect provider',
      '[transient_subagent_status]\nsub-1 is running',
      '[transient_runner_hint]\nuse a subagent',
      '[transient_runtime_context]\ndevice-a',
    ];

    const systems = variants.map(dynamic => (
      (provider as any).transformMessages(nativeMessages(dynamic)).system
    ));
    for (const system of systems) {
      assert.deepEqual(system[0], {
        type: 'text',
        text: 'Stable policy.',
        cache_control: { type: 'ephemeral' },
      });
    }
    assert.equal(new Set(systems.map(system => system[1].text)).size, variants.length);
  });

  test('honors explicit dynamic cache scope when PR 266 lands', () => {
    const provider = createProvider();
    const transformed = (provider as any).transformMessages([
      { role: 'system', content: 'Stable policy.' },
      { role: 'system', content: 'Runtime snapshot without a transient prefix', __cacheScope: 'dynamic' },
      { role: 'user', content: 'Latest query' },
    ] as any);

    assert.equal(transformed.system[0].text, 'Stable policy.');
    assert.deepEqual(transformed.system[0].cache_control, { type: 'ephemeral' });
    assert.equal(transformed.system[1].text, 'Runtime snapshot without a transient prefix');
  });

  test('does not reorder system content and skips a cache breakpoint when dynamic content comes first', () => {
    const provider = createProvider();
    const transformed = (provider as any).transformMessages([
      { role: 'system', content: '[transient_plan_status]\nfirst' },
      { role: 'system', content: 'Later system content' },
      { role: 'user', content: 'Latest query' },
    ] as Message[]);

    assert.deepEqual(transformed.system, [{
      type: 'text',
      text: '[transient_plan_status]\nfirst\n\nLater system content',
    }]);
  });

  test('keeps the legacy string system shape for Anthropic-compatible endpoints', () => {
    const provider = createProvider('https://relay.catsco.cc/anthropic');
    const transformed = (provider as any).transformMessages(nativeMessages(
      '[transient_subagent_status]\nsub-1 is running',
    ));

    assert.equal(
      transformed.system,
      'Stable policy.\n\n[transient_subagent_status]\nsub-1 is running',
    );
  });

  test('only enables native prompt caching for canonical Anthropic endpoints', () => {
    const nativeUrls = [
      'https://api.anthropic.com',
      'https://api.anthropic.com/',
      'https://api.anthropic.com/v1',
      'https://api.anthropic.com/v1/messages',
      'https://api.anthropic.com/v1/messages//',
      'https://api.anthropic.com:443/v1/messages',
    ];
    const nonNativeUrls = [
      'http://api.anthropic.com/v1/messages',
      'https://api.anthropic.com:8443/v1/messages',
      'https://api.anthropic.com/custom/path',
      'https://api.anthropic.com/v1/messages?relay=1',
      'https://user@api.anthropic.com/v1/messages',
    ];

    for (const url of nativeUrls) {
      assert.equal((createProvider(url) as any).supportsNativePromptCaching(), true, url);
    }
    for (const url of nonNativeUrls) {
      assert.equal((createProvider(url) as any).supportsNativePromptCaching(), false, url);
    }
  });

  test('normalizes repeated trailing slashes before configuring the native Anthropic client', () => {
    const provider = createProvider('https://api.anthropic.com/v1/messages//');

    assert.equal((provider as any).client.baseURL, 'https://api.anthropic.com');
    assert.equal((provider as any).supportsNativePromptCaching(), true);
  });

  test('uses native prompt-caching create and preserves cache usage totals', async () => {
    const provider = createProvider();
    let nativeParams: any;
    let compatibleCalled = false;
    (provider as any).client.beta.promptCaching.messages.create = async (params: any) => {
      nativeParams = params;
      return {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 400,
          cache_read_input_tokens: 500,
          output_tokens: 20,
        },
      };
    };
    (provider as any).client.messages.create = async () => {
      compatibleCalled = true;
      throw new Error('standard create should not be used');
    };

    const response = await provider.chat(nativeMessages('[transient_plan_status]\nrunning'));

    assert.equal(compatibleCalled, false);
    assert.deepEqual(nativeParams.system[0].cache_control, { type: 'ephemeral' });
    assert.deepEqual(
      nativeParams.messages[0].content[0].cache_control,
      { type: 'ephemeral' },
    );
    assert.deepEqual(response.usage, {
      promptTokens: 1000,
      completionTokens: 20,
      totalTokens: 1020,
      inputTokensReported: true,
      providerUsage: {
        contract: 'anthropic-messages-v1',
        input_tokens: 100,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 400,
      },
      cachedReadTokens: 500,
      cacheReadSource: 'anthropic.cache_read_input_tokens',
      cachedWriteTokens: 400,
    });
  });

  test('normalizes Anthropic input totals without inventing omitted cache fields', async () => {
    const provider = createProvider();
    (provider as any).client.beta.promptCaching.messages.create = async () => ({
      content: [{ type: 'text', text: 'missing' }],
      usage: { input_tokens: 100, output_tokens: 2 },
    });

    const missing = await provider.chat(nativeMessages('[transient_plan_status]\nrunning'));
    assert.equal(missing.usage?.promptTokens, 100);
    assert.equal(missing.usage?.totalTokens, 102);
    assert.equal(missing.usage?.inputTokensReported, true);
    assert.equal(Object.prototype.hasOwnProperty.call(missing.usage, 'cachedReadTokens'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(missing.usage, 'cachedWriteTokens'), false);

    (provider as any).client.beta.promptCaching.messages.create = async () => ({
      content: [{ type: 'text', text: 'missing raw input' }],
      usage: {
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 90,
        output_tokens: 2,
      },
    });

    const missingRawInput = await provider.chat(nativeMessages('[transient_plan_status]\nrunning'));
    assert.equal(missingRawInput.usage?.promptTokens, 100);
    assert.equal(missingRawInput.usage?.inputTokensReported, false);
    assert.equal(missingRawInput.usage?.cachedReadTokens, 90);
    assert.equal(missingRawInput.usage?.cacheReadSource, 'anthropic.cache_read_input_tokens');
    assert.equal(missingRawInput.usage?.cachedWriteTokens, 10);

    (provider as any).client.beta.promptCaching.messages.create = async () => ({
      content: [{ type: 'text', text: 'zero' }],
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 2,
      },
    });

    const explicitZero = await provider.chat(nativeMessages('[transient_plan_status]\nrunning'));
    assert.deepEqual(explicitZero.usage, {
      promptTokens: 100,
      completionTokens: 2,
      totalTokens: 102,
      inputTokensReported: true,
      providerUsage: {
        contract: 'anthropic-messages-v1',
        input_tokens: 100,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      cachedReadTokens: 0,
      cacheReadSource: 'anthropic.cache_read_input_tokens',
      cachedWriteTokens: 0,
    });
  });

  test('cache bypass uses the standard official path without any cache markers', async () => {
    const provider = createProvider();
    let seenParams: any;
    let betaCalled = false;
    (provider as any).client.messages.create = async (params: any) => {
      seenParams = params;
      return {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 1 },
      };
    };
    (provider as any).client.beta.promptCaching.messages.create = async () => {
      betaCalled = true;
      throw new Error('beta create should not be used for cache bypass');
    };

    await provider.chat(nativeMessages('[transient_plan_status]\nrunning'), [{
      name: 'lookup',
      description: 'lookup',
      parameters: { type: 'object', properties: {} },
    }], { cacheMode: 'bypass' });

    assert.equal(betaCalled, false);
    assert.equal(typeof seenParams.system, 'string');
    assert.equal(seenParams.tools[0].cache_control, undefined);
    assert.equal(JSON.stringify(seenParams.messages).includes('cache_control'), false);
  });

  test('canonicalizes tools and places a separate breakpoint on the stable tool prefix', async () => {
    const provider = createProvider();
    let nativeParams: any;
    (provider as any).client.beta.promptCaching.messages.create = async (params: any) => {
      nativeParams = params;
      return {
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    };
    const tools: ToolDefinition[] = [
      {
        name: 'zeta',
        description: 'z',
        parameters: { properties: { b: { type: 'string' }, a: { type: 'number' } }, type: 'object' },
      },
      {
        name: 'alpha',
        description: 'a',
        parameters: { type: 'object', properties: {} },
      },
    ];

    await provider.chat(nativeMessages('[transient_plan_status]\nrunning'), tools);

    assert.deepEqual(nativeParams.tools.map((tool: any) => tool.name), ['alpha', 'zeta']);
    assert.equal(nativeParams.tools[0].cache_control, undefined);
    assert.deepEqual(nativeParams.tools[1].cache_control, { type: 'ephemeral' });
    assert.deepEqual(Object.keys(nativeParams.tools[1].input_schema), ['properties', 'type']);
    assert.deepEqual(Object.keys(nativeParams.tools[1].input_schema.properties), ['a', 'b']);
    assert.deepEqual(nativeParams.system[0].cache_control, { type: 'ephemeral' });
    assert.deepEqual(
      nativeParams.messages[0].content[0].cache_control,
      { type: 'ephemeral' },
    );
  });

  test('places the growing conversation breakpoint after a trailing tool result', () => {
    const provider = createProvider();
    const transformed = (provider as any).transformMessages([
      { role: 'system', content: 'Stable policy.' },
      { role: 'user', content: 'Look up the current status.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'lookup', arguments: '{}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', name: 'lookup', content: 'ready' },
    ] as Message[]);

    const finalMessage = transformed.messages.at(-1);
    assert.equal(finalMessage.role, 'user');
    assert.equal(finalMessage.content[0].type, 'tool_result');
    assert.deepEqual(finalMessage.content[0].cache_control, { type: 'ephemeral' });
  });

  test('uses the standard create path for compatible endpoints', async () => {
    const provider = createProvider('https://relay.catsco.cc/anthropic');
    let seenParams: any;
    let betaCalled = false;
    (provider as any).client.messages.create = async (params: any) => {
      seenParams = params;
      return {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 1 },
      };
    };
    (provider as any).client.beta.promptCaching.messages.create = async () => {
      betaCalled = true;
      throw new Error('beta create should not be used');
    };

    await provider.chat(nativeMessages('[transient_plan_status]\nrunning'), [{
      name: 'lookup',
      description: 'lookup',
      parameters: { type: 'object', properties: {} },
    }]);

    assert.equal(betaCalled, false);
    assert.equal(typeof seenParams.system, 'string');
    assert.equal(seenParams.tools[0].cache_control, undefined);
  });

  test('uses the standard streaming path for compatible endpoints', async () => {
    const provider = createProvider('https://relay.catsco.cc/anthropic');
    let betaCalled = false;
    let seenParams: any;
    (provider as any).client.messages.stream = (params: any) => {
      seenParams = params;
      return {
        on() { return this; },
        async finalMessage() {
          return {
            content: [{ type: 'text', text: 'streamed' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 3, output_tokens: 1 },
          };
        },
      };
    };
    (provider as any).client.beta.promptCaching.messages.stream = () => {
      betaCalled = true;
      throw new Error('beta stream should not be used');
    };

    await provider.chatStream(nativeMessages('[transient_plan_status]\nrunning'));

    assert.equal(betaCalled, false);
    assert.equal(typeof seenParams.system, 'string');
  });

  test('uses native prompt-caching streaming and preserves cache usage', async () => {
    const provider = createProvider();
    let standardCalled = false;
    const finalMessage = {
      content: [{ type: 'text', text: 'streamed' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 70,
        output_tokens: 5,
      },
    };
    (provider as any).client.beta.promptCaching.messages.stream = () => ({
      on() { return this; },
      async finalMessage() { return finalMessage; },
    });
    (provider as any).client.messages.stream = () => {
      standardCalled = true;
      throw new Error('standard stream should not be used');
    };

    const response = await provider.chatStream(nativeMessages(
      '[transient_subagent_status]\nsub-1 is waiting',
    ));

    assert.equal(standardCalled, false);
    assert.deepEqual(response.usage, {
      promptTokens: 100,
      completionTokens: 5,
      totalTokens: 105,
      inputTokensReported: true,
      providerUsage: {
        contract: 'anthropic-messages-v1',
        input_tokens: 10,
        cache_read_input_tokens: 70,
        cache_creation_input_tokens: 20,
      },
      cachedReadTokens: 70,
      cacheReadSource: 'anthropic.cache_read_input_tokens',
      cachedWriteTokens: 20,
    });
  });
});
