#!/usr/bin/env node
/**
 * 清理旧日志 - 保留最近 30 天
 */
import fs from 'fs';
import path from 'path';

const RUNTIME_LOG_DIR = 'logs';
const SESSION_LOG_DIR = 'logs/sessions';
const RETENTION_DAYS = 30;

console.log('🧹 清理旧日志\n');

const now = Date.now();
const cutoffTime = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;

let deletedCount = 0;
let totalSize = 0;

// 清理 runtime logs (logs/YYYY-MM-DD/)
console.log('1️⃣ 清理 runtime logs...');
if (fs.existsSync(RUNTIME_LOG_DIR)) {
  const entries = fs.readdirSync(RUNTIME_LOG_DIR);

  for (const entry of entries) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry)) continue; // 只处理日期目录

    const dirPath = path.join(RUNTIME_LOG_DIR, entry);
    const stat = fs.statSync(dirPath);

    if (stat.isDirectory() && stat.mtimeMs < cutoffTime) {
      const size = getDirSize(dirPath);
      fs.rmSync(dirPath, { recursive: true });
      deletedCount++;
      totalSize += size;
      console.log(`   🗑️  删除: ${entry} (${formatSize(size)})`);
    }
  }
}

console.log(`\n✅ 清理完成: 删除 ${deletedCount} 个目录，释放 ${formatSize(totalSize)}`);

function getDirSize(dirPath) {
  let size = 0;
  const files = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const file of files) {
    const filePath = path.join(dirPath, file.name);
    if (file.isDirectory()) {
      size += getDirSize(filePath);
    } else {
      size += fs.statSync(filePath).size;
    }
  }

  return size;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
