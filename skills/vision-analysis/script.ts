#!/usr/bin/env node
/**
 * Vision Analysis Skill Script
 * 
 * 输入：通过 execute_shell 调用，参数通过 stdin JSON 传入
 * 配置：通过 tool 调用的 context.config 参数传入
 * 
 * 输入格式：
 * {
 *   "input": {
 *     "image_path": "/path/to/image.png",
 *     "analysis_prompt": "可选的分析提示"
 *   },
 *   "config": {
 *     "provider": "anthropic",
 *     "api_key": "sk-xxx",
 *     "model": "claude-3-5-sonnet-20240620",
 *     "base_url": "https://api.anthropic.com/v1",
 *     "analysis_prompt": "请详细描述这张图片",
 *     "max_tokens": 1024
 *   }
 * }
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

// ─── 配置检查 ───────────────────────────────────────────

interface VisionConfig {
  provider?: string;
  api_key?: string;
  model?: string;
  base_url?: string;
  analysis_prompt?: string;
  max_tokens?: number;
}

interface VisionInput {
  image_path: string;
  analysis_prompt?: string;
}

interface ToolContext {
  workingDirectory?: string;
  sessionKey?: string;
}

interface SkillInput {
  input: VisionInput;
  config: VisionConfig;
  context: ToolContext;
}

// ─── 图片处理 ───────────────────────────────────────────

interface ProcessedImage {
  base64: string;
  mediaType: string;
  originalSize: number;
  compressedSize: number;
}

async function processImage(filePath: string): Promise<ProcessedImage | null> {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const buffer = fs.readFileSync(filePath);
    const originalSize = buffer.length;

    // 简单压缩：resize + JPEG
    const resized = await resizeImage(buffer, 1568, 1568);
    const compressedSize = resized.length;

    const ext = path.extname(filePath).toLowerCase();
    const mediaType = ext === '.png' ? 'image/png' : 'image/jpeg';

    return {
      base64: resized.toString('base64'),
      mediaType,
      originalSize,
      compressedSize
    };
  } catch (error) {
    console.error('图片处理失败:', error);
    return null;
  }
}

async function resizeImage(buffer: Buffer, maxWidth: number, maxHeight: number): Promise<Buffer> {
  // 简单实现：只做 JPEG 压缩，不做真正的 resize（需要 sharp 库）
  // 如果需要 resize，可以在这里调用 sharp
  // 暂时直接返回压缩后的 buffer（JPEG 压缩）
  
  // 检查是否有 sharp
  try {
    const sharp = require('sharp');
    const image = sharp(buffer);
    const metadata = await image.metadata();
    
    // 如果图片已经小于目标尺寸，不缩放
    if (metadata.width <= maxWidth && metadata.height <= maxHeight) {
      return await image.jpeg({ quality: 85 }).toBuffer();
    }
    
    // 缩放并压缩
    return await image
      .resize(maxWidth, maxHeight, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch {
    // 没有 sharp，直接返回原 buffer（假设是 JPEG）
    return buffer;
  }
}

// ─── API 调用 ───────────────────────────────────────────

async function callAnthropicAPI(
  apiKey: string,
  model: string,
  baseUrl: string,
  imageData: string,
  mediaType: string,
  prompt: string,
  maxTokens: number
): Promise<string> {
  const url = new URL(`${baseUrl}/messages`);
  
  const requestBody = {
    model,
    max_tokens: maxTokens,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType,
            data: imageData
          }
        },
        {
          type: 'text',
          text: prompt
        }
      ]
    }]
  };

  return new Promise((resolve, reject) => {
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          try {
            const error = JSON.parse(data);
            reject(new Error(error.error?.message || `API 错误: ${res.statusCode}`));
          } catch {
            reject(new Error(`API 错误: ${res.statusCode}`));
          }
          return;
        }
        
        try {
          const response = JSON.parse(data);
          const text = response.content?.[0]?.text;
          resolve(text || '分析完成');
        } catch (e) {
          reject(new Error('解析响应失败'));
        }
      });
    });

    req.on('error', reject);
    req.write(JSON.stringify(requestBody));
    req.end();
  });
}

async function callOpenAIAPI(
  apiKey: string,
  model: string,
  baseUrl: string,
  imageData: string,
  mediaType: string,
  prompt: string,
  maxTokens: number
): Promise<string> {
  const url = new URL(`${baseUrl}/chat/completions`);
  
  const requestBody = {
    model,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: {
            url: `data:${mediaType};base64,${imageData}`
          }
        },
        {
          type: 'text',
          text: prompt
        }
      ]
    }],
    max_tokens: maxTokens
  };

  return new Promise((resolve, reject) => {
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          try {
            const error = JSON.parse(data);
            reject(new Error(error.error?.message || `API 错误: ${res.statusCode}`));
          } catch {
            reject(new Error(`API 错误: ${res.statusCode}`));
          }
          return;
        }
        
        try {
          const response = JSON.parse(data);
          const text = response.choices?.[0]?.message?.content;
          resolve(text || '分析完成');
        } catch (e) {
          reject(new Error('解析响应失败'));
        }
      });
    });

    req.on('error', reject);
    req.write(JSON.stringify(requestBody));
    req.end();
  });
}

// ─── 主逻辑 ───────────────────────────────────────────

async function main() {
  try {
    // 读取输入
    const inputData: SkillInput = JSON.parse(fs.readFileSync(0, 'utf-8'));
    const { input, config } = inputData;

    // ─── Step 1: 检查配置 ───
    const missing: string[] = [];
    
    if (!config.provider) missing.push('provider');
    if (!config.api_key) missing.push('api_key');
    if (!config.model) missing.push('model');

    if (missing.length > 0) {
      console.log(JSON.stringify({
        status: 'config_incomplete',
        missing,
        message: `缺少必填配置: ${missing.join(', ')}。请在 SKILL.md 的 config 中提供完整配置。`
      }, null, 2));
      return;
    }

    // ─── Step 2: 处理图片 ───
    let imagePath = input.image_path;
    
    // 解析相对路径
    if (!path.isAbsolute(imagePath) && inputData.context?.workingDirectory) {
      imagePath = path.join(inputData.context.workingDirectory, imagePath);
    }

    const processedImage = await processImage(imagePath);
    
    if (!processedImage) {
      console.log(JSON.stringify({
        status: 'error',
        error: `图片读取失败: ${input.image_path} 不存在或无法处理`
      }, null, 2));
      return;
    }

    // ─── Step 3: 调用视觉模型 ───
    const provider = config.provider || 'anthropic';
    const apiKey = config.api_key!;
    const model = config.model!;
    const baseUrl = config.base_url || (
      provider === 'anthropic' 
        ? 'https://api.anthropic.com/v1'
        : 'https://api.openai.com/v1'
    );
    const prompt = input.analysis_prompt || config.analysis_prompt || '请详细描述这张图片的内容';
    const maxTokens = config.max_tokens || 1024;

    let analysis: string;
    
    if (provider === 'anthropic') {
      analysis = await callAnthropicAPI(
        apiKey, model, baseUrl,
        processedImage.base64,
        processedImage.mediaType,
        prompt,
        maxTokens
      );
    } else if (provider === 'openai') {
      analysis = await callOpenAIAPI(
        apiKey, model, baseUrl,
        processedImage.base64,
        processedImage.mediaType,
        prompt,
        maxTokens
      );
    } else {
      console.log(JSON.stringify({
        status: 'error',
        error: `不支持的 provider: ${provider}。支持的 provider: anthropic, openai`
      }, null, 2));
      return;
    }

    // ─── Step 4: 返回结果 ───
    console.log(JSON.stringify({
      status: 'success',
      analysis,
      model_used: model,
      image_info: {
        original_size: processedImage.originalSize,
        compressed_size: processedImage.compressedSize,
        media_type: processedImage.mediaType
      }
    }, null, 2));

  } catch (error: any) {
    console.log(JSON.stringify({
      status: 'error',
      error: error.message || '执行失败'
    }, null, 2));
  }
}

main();
