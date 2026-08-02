import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { AnthropicProvider } from '../src/providers/anthropic-provider';
import { Message } from '../src/types';

describe('AnthropicProvider - Extra Fields in Image Block Bug', () => {
  test('should filter out extra fields (dimensions, filePath) from image blocks in user messages', () => {
    // 模拟 CatsCompany 发来的用户消息，图片块包含额外字段
    const messages: Message[] = [
      {
        role: 'system',
        content: 'You are a helpful assistant.'
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: '看看这张图' },
          { 
            type: 'image', 
            source: { 
              type: 'base64', 
              media_type: 'image/jpeg', 
              data: 'fake-base64-data' 
            },
            // 这些额外字段会导致 Anthropic API 报错
            dimensions: {
              originalWidth: 1920,
              originalHeight: 1080,
              displayWidth: 800,
              displayHeight: 450
            },
            filePath: '/tmp/test-image.jpg'
          } as any
        ]
      }
    ];

    const provider = new AnthropicProvider({
      apiKey: 'fake-key',
      apiUrl: 'https://api.anthropic.com/v1/messages',
      model: 'claude-sonnet-4-20250514'
    });

    const transformMessages = (provider as any).transformMessages.bind(provider);
    const result = transformMessages(messages);

    // 验证转换后的消息
    assert.strictEqual(result.messages.length, 1);
    assert.strictEqual(result.messages[0].role, 'user');
    
    const content = result.messages[0].content as any[];
    assert.ok(Array.isArray(content), 'Content should be an array');
    assert.strictEqual(content.length, 2, 'Should have 2 blocks (text + image)');
    
    // 验证图片块
    const imageBlock = content[1];
    assert.strictEqual(imageBlock.type, 'image');
    assert.ok(imageBlock.source, 'Image block should have source');
    assert.strictEqual(imageBlock.source.type, 'base64');
    assert.strictEqual(imageBlock.source.media_type, 'image/jpeg');
    
    // 关键：验证额外字段被过滤掉
    assert.strictEqual(imageBlock.dimensions, undefined, 
      'dimensions field should be filtered out');
    assert.strictEqual(imageBlock.filePath, undefined, 
      'filePath field should be filtered out');
    
    // 官方端点允许最后一个内容块携带 prompt-cache 断点；业务侧额外字段仍必须移除。
    const imageBlockKeys = Object.keys(imageBlock);
    assert.deepStrictEqual(imageBlockKeys.sort(), ['cache_control', 'source', 'type'],
      'Image block should only have protocol-defined fields');
    assert.deepStrictEqual(imageBlock.cache_control, { type: 'ephemeral' });
  });

  test('should filter out extra fields from image blocks in tool results', () => {
    // 模拟工具返回的图片结果
    const messages: Message[] = [
      {
        role: 'system',
        content: 'You are a helpful assistant.'
      },
      {
        role: 'user',
        content: '生成一张图'
      },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_123',
          type: 'function',
          function: {
            name: 'generate_image',
            arguments: '{}'
          }
        }]
      },
      {
        role: 'tool',
        tool_call_id: 'call_123',
        name: 'generate_image',
        content: [
          { type: 'text', text: '图片已生成' },
          { 
            type: 'image', 
            source: { 
              type: 'base64', 
              media_type: 'image/png', 
              data: 'fake-png-data' 
            },
            dimensions: { originalWidth: 512, originalHeight: 512 },
            filePath: '/tmp/generated.png'
          } as any
        ]
      }
    ];

    const provider = new AnthropicProvider({
      apiKey: 'fake-key',
      apiUrl: 'https://api.anthropic.com/v1/messages',
      model: 'claude-sonnet-4-20250514'
    });

    const transformMessages = (provider as any).transformMessages.bind(provider);
    const result = transformMessages(messages);

    // 找到包含 tool_result 的消息
    const userMsg = result.messages.find((m: any) => 
      m.role === 'user' && Array.isArray(m.content)
    );
    
    assert.ok(userMsg, 'Should have user message with tool results');
    
    const content = userMsg.content as any[];
    // 应该有 tool_result 和独立的 image block
    const imageBlocks = content.filter((b: any) => b.type === 'image');
    
    assert.ok(imageBlocks.length > 0, 'Should have image blocks');
    
    // 验证图片块没有额外字段
    for (const imgBlock of imageBlocks) {
      assert.strictEqual(imgBlock.dimensions, undefined, 
        'dimensions should be filtered from tool result images');
      assert.strictEqual(imgBlock.filePath, undefined, 
        'filePath should be filtered from tool result images');
      
      const keys = Object.keys(imgBlock);
      assert.deepStrictEqual(keys.sort(), ['cache_control', 'source', 'type'],
        'Image block should only have protocol-defined fields');
      assert.deepStrictEqual(imgBlock.cache_control, { type: 'ephemeral' });
    }
  });
});
