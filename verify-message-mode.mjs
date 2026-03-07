#!/usr/bin/env node
/**
 * Message-Based Mode 功能验证脚本
 * 验证核心组件是否正确实现
 */

import { ThinkingTool } from './src/tools/thinking-tool.js';
import { ToolManager } from './src/tools/tool-manager.js';

console.log('=== Message-Based Mode 功能验证 ===\n');

// 测试 1: ThinkingTool 存在且可实例化
console.log('测试 1: ThinkingTool 类');
try {
  const thinkingTool = new ThinkingTool();
  console.log('✅ ThinkingTool 实例化成功');
  console.log(`   工具名: ${thinkingTool.definition.name}`);
  console.log(`   描述: ${thinkingTool.definition.description.slice(0, 50)}...`);
} catch (err) {
  console.log('❌ ThinkingTool 实例化失败:', err.message);
}

console.log('\n测试 2: ToolManager 在 message mode 下注册 thinking');
try {
  process.env.GAUZ_MESSAGE_MODE = 'message';
  const toolManager = new ToolManager();
  const tools = toolManager.getToolDefinitions();
  const hasThinking = tools.some(t => t.name === 'thinking');
  const hasReply = tools.some(t => t.name === 'reply');

  if (hasThinking && !hasReply) {
    console.log('✅ Message mode 工具配置正确');
    console.log(`   - thinking: 已注册`);
    console.log(`   - reply: 未注册 (正确)`);
  } else {
    console.log('❌ Message mode 工具配置错误');
    console.log(`   - thinking: ${hasThinking ? '已注册' : '未注册'}`);
    console.log(`   - reply: ${hasReply ? '已注册 (错误)' : '未注册'}`);
  }
} catch (err) {
  console.log('❌ ToolManager 测试失败:', err.message);
}

console.log('\n测试 3: ToolManager 在 ultra mode 下注册 reply');
try {
  process.env.GAUZ_MESSAGE_MODE = 'ultra';
  const toolManager = new ToolManager();
  const tools = toolManager.getToolDefinitions();
  const hasThinking = tools.some(t => t.name === 'thinking');
  const hasReply = tools.some(t => t.name === 'reply');

  if (!hasThinking && hasReply) {
    console.log('✅ Ultra mode 工具配置正确');
    console.log(`   - thinking: 未注册 (正确)`);
    console.log(`   - reply: 已注册`);
  } else {
    console.log('❌ Ultra mode 工具配置错误');
    console.log(`   - thinking: ${hasThinking ? '已注册 (错误)' : '未注册'}`);
    console.log(`   - reply: ${hasReply ? '已注册' : '未注册'}`);
  }
} catch (err) {
  console.log('❌ ToolManager 测试失败:', err.message);
}

console.log('\n测试 4: thinking 工具执行');
try {
  const thinkingTool = new ThinkingTool();
  const result = await thinkingTool.execute(
    { content: '这是一个测试思考' },
    { sessionId: 'test', surface: 'cli', permissionProfile: 'strict' }
  );

  if (result === '继续推理') {
    console.log('✅ thinking 工具执行成功');
    console.log(`   返回: "${result}"`);
  } else {
    console.log('❌ thinking 工具返回值错误');
    console.log(`   期望: "继续推理"`);
    console.log(`   实际: "${result}"`);
  }
} catch (err) {
  console.log('❌ thinking 工具执行失败:', err.message);
}

console.log('\n=== 验证完成 ===');
