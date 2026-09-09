import * as fs from 'node:fs';
import * as path from 'node:path';
import { PathResolver } from '../utils/path-resolver';

// Prevent accidental bypass of the knowledge helper by local file tools.
// This is not an OS sandbox: the user can still edit Markdown outside the agent.
export function isManagedKnowledgePath(filePath: string): boolean {
  const root = path.join(PathResolver.getRuntimeDataRoot(), 'knowledge');
  return isWithin(root, filePath) || isWithin(canonicalPath(root), canonicalPath(filePath));
}

function isWithin(root: string, file: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function canonicalPath(file: string): string {
  const absolute = path.resolve(file);
  try { return fs.realpathSync.native(absolute); } catch {
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(canonicalPath(parent), path.basename(absolute));
  }
}

export const KNOWLEDGE_WRITE_GUIDANCE = '知识目录由 xiaoba-knowledge 的 put/reindex 管理，不能直接写入或编辑。请重新加载该 Skill，原样使用返回的脚本绝对路径，经 put 的版本检查和历史归档更新；脚本不可用时报告阻碍，不用其他文件工具或 shell 绕过。临时请求 JSON 请写到知识目录外。';
