import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type TimetableTaskStatus =
  | 'collecting_requirements'
  | 'ready_to_validate'
  | 'validating'
  | 'ready_to_solve'
  | 'solving'
  | 'completed'
  | 'needs_review';

export interface TimetableInput {
  id: string;
  type: 'text';
  content: string;
  attachments?: TimetableAttachment[];
  createdAt: string;
}

export interface TimetableAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  path: string;
  createdAt: string;
}

export interface TimetableRequirement {
  id: string;
  text: string;
  sourceInputId: string;
  status: 'pending_review';
  createdAt: string;
}

export interface TimetableTask {
  id: string;
  title: string;
  status: TimetableTaskStatus;
  createdAt: string;
  updatedAt: string;
  inputs: TimetableInput[];
  requirements: TimetableRequirement[];
  missingInformation: string[];
  conflicts: unknown[];
  artifacts: unknown[];
  nextActions: string[];
}

interface TimetableTaskFile {
  version: 1;
  tasks: TimetableTask[];
}

export class TimetableStore {
  private readonly filePath: string;

  constructor(rootDir: string = process.cwd()) {
    this.filePath = path.join(rootDir, 'data', 'timetable', 'tasks.json');
  }

  listTasks(): TimetableTask[] {
    return this.readFile().tasks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getTask(id: string): TimetableTask {
    const task = this.readFile().tasks.find(item => item.id === id);
    if (!task) throw statusError('timetable task not found', 404);
    return task;
  }

  createTask(input: { message: unknown; title?: unknown; attachments?: unknown }): TimetableTask {
    const message = normalizeMessage(input.message);
    const attachments = normalizeAttachments(input.attachments);
    const now = new Date().toISOString();
    const inputId = createId('tti');
    const requirement = createRequirementFromMessage(message, inputId, now);
    const task: TimetableTask = {
      id: createId('tt'),
      title: normalizeTitle(input.title, message),
      status: 'collecting_requirements',
      createdAt: now,
      updatedAt: now,
      inputs: [{
        id: inputId,
        type: 'text',
        content: message,
        attachments,
        createdAt: now,
      }],
      requirements: requirement ? [requirement] : [],
      missingInformation: createMissingInformation(Boolean(requirement)),
      conflicts: [],
      artifacts: [],
      nextActions: createNextActions(Boolean(requirement), false),
    };

    const data = this.readFile();
    data.tasks.push(task);
    this.writeFile(data);
    return task;
  }

  appendTeacherMessage(id: string, messageValue: unknown, attachmentsValue?: unknown): TimetableTask {
    const message = normalizeMessage(messageValue);
    const attachments = normalizeAttachments(attachmentsValue);
    const data = this.readFile();
    const task = data.tasks.find(item => item.id === id);
    if (!task) throw statusError('timetable task not found', 404);

    const now = new Date().toISOString();
    const inputId = createId('tti');
    task.updatedAt = now;
    task.status = 'collecting_requirements';
    task.inputs.push({
      id: inputId,
      type: 'text',
      content: message,
      attachments,
      createdAt: now,
    });
    const requirement = createRequirementFromMessage(message, inputId, now);
    if (requirement) task.requirements.push(requirement);
    task.missingInformation = createMissingInformation(task.requirements.length > 0);
    task.nextActions = createNextActions(task.requirements.length > 0, true);

    this.writeFile(data);
    return task;
  }

  saveUploads(filesValue: unknown): TimetableAttachment[] {
    const files = normalizeUploadFiles(filesValue);
    const now = new Date().toISOString();
    const uploadDir = path.join('data', 'timetable', 'uploads');
    const absoluteUploadDir = path.join(path.dirname(this.filePath), 'uploads');
    fs.mkdirSync(absoluteUploadDir, { recursive: true });

    return files.map(file => {
      const id = createId('ttu');
      const safeName = sanitizeFileName(file.name);
      const relativePath = path.join(uploadDir, `${id}-${safeName}`);
      const absolutePath = path.join(absoluteUploadDir, `${id}-${safeName}`);
      const buffer = Buffer.from(file.dataBase64, 'base64');
      fs.writeFileSync(absolutePath, buffer);
      return {
        id,
        name: file.name,
        type: file.type,
        size: buffer.length,
        path: relativePath,
        createdAt: now,
      };
    });
  }

  private readFile(): TimetableTaskFile {
    if (!fs.existsSync(this.filePath)) return { version: 1, tasks: [] };
    const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as TimetableTaskFile;
    return {
      version: 1,
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    };
  }

  private writeFile(data: TimetableTaskFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify({ version: 1, tasks: data.tasks }, null, 2));
  }
}

function createRequirement(text: string, sourceInputId: string, createdAt: string): TimetableRequirement {
  return {
    id: createId('ttr'),
    text,
    sourceInputId,
    status: 'pending_review',
    createdAt,
  };
}

function createRequirementFromMessage(text: string, sourceInputId: string, createdAt: string): TimetableRequirement | null {
  return isTimetableRequirementMessage(text) ? createRequirement(text, sourceInputId, createdAt) : null;
}

function createMissingInformation(hasRequirement: boolean): string[] {
  if (!hasRequirement) {
    return ['可以直接告诉我要排哪个年级/班级，或上传教师、课程、作息时间等资料。'];
  }
  return ['请上传排课资料包、Excel、截图，或继续补充班级/教师/课程要求。'];
}

function createNextActions(hasRequirement: boolean, hasExistingTask: boolean): string[] {
  if (!hasRequirement) {
    return [
      '说出排课目标',
      '上传排课资料包',
      '补充教师/班级/课程信息',
    ];
  }
  return [
    '继续补充排课资料',
    '检查已录入条件',
    hasExistingTask ? '准备生成课表' : '上传排课资料包',
  ];
}

function isTimetableRequirementMessage(message: string): boolean {
  const text = message.trim().replace(/\s+/g, '');
  if (/^(你好|您好|hi|hello|哈喽|在吗|在不在)[。！!,.，？?]*$/i.test(text)) return false;
  if (/^(谢谢|好的|收到|明白|ok|OK)[。！!,.，？?]*$/.test(text)) return false;
  if (/^(导出|下载|查看|刷新|新建|检查)/.test(text)) return false;
  return /排课|课表|年级|班级|教师|老师|课程|教室|第[一二三四五六七八九十\d]+节|周[一二三四五六日天]|上午|下午|晚自习|活动课|体育/.test(text);
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function normalizeAttachments(value: unknown): TimetableAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    const attachment = item as Partial<TimetableAttachment>;
    const id = String(attachment.id || '').trim();
    const name = String(attachment.name || '').trim();
    const type = String(attachment.type || '').trim();
    const relativePath = String(attachment.path || '').trim();
    const createdAt = String(attachment.createdAt || '').trim();
    const size = Number(attachment.size || 0);
    if (!id || !name || !relativePath || !createdAt) throw statusError('invalid timetable attachment', 400);
    return {
      id,
      name,
      type,
      size: Number.isFinite(size) && size > 0 ? size : 0,
      path: relativePath,
      createdAt,
    };
  });
}

function normalizeUploadFiles(value: unknown): Array<{ name: string; type: string; size: number; dataBase64: string }> {
  if (!Array.isArray(value) || !value.length) throw statusError('files are required', 400);
  if (value.length > 8) throw statusError('too many timetable files', 400);
  return value.map(item => {
    const file = item as Record<string, unknown>;
    const name = String(file.name || '').trim();
    const type = String(file.type || '').trim();
    const dataBase64 = String(file.dataBase64 || '').trim();
    const size = Number(file.size || 0);
    if (!name) throw statusError('file name is required', 400);
    if (!dataBase64) throw statusError('file data is required', 400);
    if (Number.isFinite(size) && size > 15 * 1024 * 1024) throw statusError('file is too large', 400);
    return { name, type, size: Number.isFinite(size) ? size : 0, dataBase64 };
  });
}

function sanitizeFileName(value: string): string {
  const normalized = value.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim();
  return normalized.slice(0, 120) || 'timetable-file';
}

function normalizeMessage(value: unknown): string {
  const message = String(value || '').trim();
  if (!message) throw statusError('message is required', 400);
  if (message.length > 4000) throw statusError('message is too long', 400);
  return message;
}

function normalizeTitle(value: unknown, message: string): string {
  const explicit = String(value || '').trim();
  if (explicit) return explicit.slice(0, 60);
  return message.length > 18 ? `${message.slice(0, 18)}...` : message;
}

function statusError(message: string, status: number): Error {
  const error = new Error(message);
  (error as any).status = status;
  return error;
}
