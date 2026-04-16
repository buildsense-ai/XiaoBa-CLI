import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import { glob } from 'glob';
import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { getInspectorServerUrl } from '../utils/inspector-upload-config';

export type InspectorAnalysisType = 'runtime' | 'skill' | 'auto';

export interface SelectedLogFile {
  absolutePath: string;
  relativePath: string;
  kind: 'runtime_log' | 'session_jsonl';
  size: number;
}

export interface SendToInspectorExecutionResult {
  analysisType: 'runtime' | 'skill';
  selectedFiles: SelectedLogFile[];
  bundleDir: string;
  uploaded: boolean;
  dryRun: boolean;
  caseId?: string;
  response?: any;
  message: string;
}

const DEFAULT_MAX_FILES = 6;
const DEFAULT_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export class SendToInspectorTool implements Tool {
  definition: ToolDefinition = {
    name: 'send_to_inspector',
    description: '将 XiaoBa 的运行日志打包并上传到配置好的 Inspector 服务。仅允许上传 logs/ 下的 .log 和 .jsonl 文件。只在用户明确要求交给 Inspector / 督察猫查看日志时使用。',
    parameters: {
      type: 'object',
      properties: {
        analysis_type: {
          type: 'string',
          enum: ['runtime', 'skill', 'auto'],
          description: '诊断类型。runtime 优先上传 .log，skill 优先上传 .jsonl，auto 根据 user_request 自动判断。',
        },
        user_request: {
          type: 'string',
          description: '用户原始诉求摘要，会写入交接单并上传给 Inspector。',
        },
        date: {
          type: 'string',
          description: '日志日期，格式 YYYY-MM-DD。不填时自动选择最新日期。',
        },
        log_paths: {
          type: 'array',
          description: '显式指定要上传的日志路径列表。只能是 logs/ 下的 .log 或 .jsonl。',
          items: { type: 'string' },
        },
        max_files: {
          type: 'number',
          description: `最大上传文件数，默认 ${DEFAULT_MAX_FILES}。`,
        },
        dry_run: {
          type: 'boolean',
          description: '只生成本地诊断包，不上传。',
          default: false,
        },
      },
      required: ['analysis_type'],
    },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    const result = await this.executeWithResult(args, context);
    return result.message;
  }

  async executeWithResult(args: any, context: ToolExecutionContext): Promise<SendToInspectorExecutionResult> {
    const analysisType = this.resolveAnalysisType(args.analysis_type, args.user_request);
    const maxFiles = this.parseMaxFiles(args.max_files);
    const dryRun = args.dry_run === true;
    const projectRoot = context.workingDirectory;
    const logsRoot = path.resolve(projectRoot, 'logs');

    if (!fs.existsSync(logsRoot) || !fs.statSync(logsRoot).isDirectory()) {
      return {
        analysisType,
        selectedFiles: [],
        bundleDir: '',
        uploaded: false,
        dryRun,
        message: `错误：未找到日志目录: ${logsRoot}`,
      };
    }

    const selectedFiles = Array.isArray(args.log_paths) && args.log_paths.length > 0
      ? this.collectExplicitFiles(args.log_paths, projectRoot, logsRoot, maxFiles)
      : await this.collectFilesByMode(logsRoot, analysisType, args.date, maxFiles);

    if (selectedFiles.length === 0) {
      return {
        analysisType,
        selectedFiles,
        bundleDir: '',
        uploaded: false,
        dryRun,
        message: '错误：未找到可上传的日志文件',
      };
    }

    const totalBytes = selectedFiles.reduce((sum, file) => sum + file.size, 0);
    const maxTotalBytes = Number(process.env.XIAOBA_INSPECTOR_MAX_UPLOAD_BYTES || DEFAULT_MAX_TOTAL_BYTES);
    if (totalBytes > maxTotalBytes) {
      return {
        analysisType,
        selectedFiles,
        bundleDir: '',
        uploaded: false,
        dryRun,
        message: `错误：日志包过大 (${this.formatBytes(totalBytes)})，已超过限制 ${this.formatBytes(maxTotalBytes)}。请减少文件范围。`,
      };
    }

    const bundleDir = this.createBundleDirectory(projectRoot, analysisType);
    const manifest = this.buildManifest(analysisType, args.user_request, args.date, selectedFiles);
    const caseMarkdown = this.buildCaseMarkdown(manifest);
    const payload = this.buildPayload(analysisType, args.user_request, selectedFiles, bundleDir, projectRoot);

    fs.writeFileSync(path.join(bundleDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
    fs.writeFileSync(path.join(bundleDir, 'case.md'), caseMarkdown, 'utf-8');
    fs.writeFileSync(path.join(bundleDir, 'upload-payload.json'), JSON.stringify(payload, null, 2), 'utf-8');

    if (dryRun || !getInspectorServerUrl()) {
      return {
        analysisType,
        selectedFiles,
        bundleDir,
        uploaded: false,
        dryRun,
        message: [
        `已生成 Inspector 诊断包（未上传）。`,
        `类型: ${analysisType}`,
        `文件数: ${selectedFiles.length}`,
        `位置: ${bundleDir}`,
        ].join('\n'),
      };
    }

    const response = await this.uploadBundle(payload, bundleDir);
    const responsePath = path.join(bundleDir, 'upload-result.json');
    fs.writeFileSync(responsePath, JSON.stringify(response, null, 2), 'utf-8');

    return {
      analysisType,
      selectedFiles,
      bundleDir,
      uploaded: true,
      dryRun,
      caseId: response.caseId || 'unknown',
      response,
      message: [
        `已上传 Inspector 诊断包。`,
        `类型: ${analysisType}`,
        `文件数: ${selectedFiles.length}`,
        `caseId: ${response.caseId || 'unknown'}`,
        `位置: ${bundleDir}`,
      ].join('\n'),
    };
  }

  private resolveAnalysisType(rawType: unknown, userRequest: unknown): Exclude<InspectorAnalysisType, 'auto'> {
    const normalized = String(rawType || 'auto').trim().toLowerCase() as InspectorAnalysisType;
    if (normalized === 'runtime' || normalized === 'skill') {
      return normalized;
    }

    const request = String(userRequest || '');
    if (/提炼|skill|工作流|触发|重复/i.test(request)) {
      return 'skill';
    }
    return 'runtime';
  }

  private parseMaxFiles(rawMaxFiles: unknown): number {
    const parsed = Number(rawMaxFiles);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return DEFAULT_MAX_FILES;
    }
    return Math.min(Math.floor(parsed), 12);
  }

  private collectExplicitFiles(rawPaths: string[], projectRoot: string, logsRoot: string, maxFiles: number): SelectedLogFile[] {
    const results: SelectedLogFile[] = [];

    for (const rawPath of rawPaths.slice(0, maxFiles)) {
      const absolutePath = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(projectRoot, rawPath);
      if (!this.isAllowedLogPath(absolutePath, logsRoot)) {
        throw new Error(`不允许上传非日志文件: ${rawPath}`);
      }
      if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
        throw new Error(`日志文件不存在: ${rawPath}`);
      }
      results.push(this.toSelectedFile(absolutePath, logsRoot));
    }

    return results;
  }

  private async collectFilesByMode(
    logsRoot: string,
    analysisType: 'runtime' | 'skill',
    date: string | undefined,
    maxFiles: number,
  ): Promise<SelectedLogFile[]> {
    const targetDate = date || await this.findLatestDate(logsRoot, analysisType);
    if (!targetDate) {
      return [];
    }

    const runtimeCandidates = await glob(`${targetDate}/*.log`, {
      cwd: logsRoot,
      absolute: true,
      nodir: true,
      windowsPathsNoEscape: true,
    });

    const sessionCandidates = await glob(`sessions/*/${targetDate}/*.jsonl`, {
      cwd: logsRoot,
      absolute: true,
      nodir: true,
      windowsPathsNoEscape: true,
    });

    const prioritized = analysisType === 'runtime'
      ? [...runtimeCandidates, ...sessionCandidates]
      : [...sessionCandidates, ...runtimeCandidates];

    return prioritized
      .filter(filePath => this.isAllowedLogPath(filePath, logsRoot))
      .slice(0, maxFiles)
      .map(filePath => this.toSelectedFile(filePath, logsRoot));
  }

  private async findLatestDate(logsRoot: string, analysisType: 'runtime' | 'skill'): Promise<string | null> {
    const patterns = analysisType === 'runtime'
      ? ['*/', 'sessions/*/*/']
      : ['sessions/*/*/', '*/'];

    for (const pattern of patterns) {
      const matches = await glob(pattern, {
        cwd: logsRoot,
        absolute: false,
        mark: true,
        windowsPathsNoEscape: true,
      });
      const dates = matches
        .map(match => match.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '')
        .filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value))
        .sort();

      if (dates.length > 0) {
        return dates[dates.length - 1];
      }
    }

    return null;
  }

  private isAllowedLogPath(targetPath: string, logsRoot: string): boolean {
    const absolutePath = path.resolve(targetPath);
    const normalizedRoot = path.resolve(logsRoot).toLowerCase();
    const normalizedPath = absolutePath.toLowerCase();
    const rootWithSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
    if (!(normalizedPath === normalizedRoot || normalizedPath.startsWith(rootWithSep))) {
      return false;
    }

    return /\.(log|jsonl)$/i.test(absolutePath);
  }

  private toSelectedFile(absolutePath: string, logsRoot: string): SelectedLogFile {
    const stats = fs.statSync(absolutePath);
    return {
      absolutePath,
      relativePath: path.relative(logsRoot, absolutePath).replace(/\\/g, '/'),
      kind: /\.jsonl$/i.test(absolutePath) ? 'session_jsonl' : 'runtime_log',
      size: stats.size,
    };
  }

  private createBundleDirectory(projectRoot: string, analysisType: 'runtime' | 'skill'): string {
    const now = new Date();
    const timestamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0'),
    ].join('-');

    const bundleDir = path.join(projectRoot, 'files', 'inspector-cases', `${timestamp}-${analysisType}`);
    fs.mkdirSync(bundleDir, { recursive: true });
    return bundleDir;
  }

  private buildManifest(
    analysisType: 'runtime' | 'skill',
    userRequest: unknown,
    date: string | undefined,
    files: SelectedLogFile[],
  ) {
    return {
      case_type: analysisType,
      created_at: new Date().toISOString(),
      scope: date || 'latest-available',
      user_request: String(userRequest || ''),
      selected_files: files.map(file => ({
        path: file.relativePath,
        kind: file.kind,
        size: file.size,
      })),
    };
  }

  private buildCaseMarkdown(manifest: { case_type: string; scope: string; user_request: string; selected_files: Array<{ path: string; kind: string }> }): string {
    const lines = [
      '# Inspector 诊断交接单',
      '',
      `- 类型：${manifest.case_type}`,
      `- 收集范围：${manifest.scope}`,
      `- 用户诉求：${manifest.user_request || '未提供'}`,
      '- 附件：',
      ...manifest.selected_files.map(file => `  - ${file.path} (${file.kind})`),
    ];
    return lines.join('\n');
  }

  private buildPayload(
    analysisType: 'runtime' | 'skill',
    userRequest: unknown,
    files: SelectedLogFile[],
    bundleDir: string,
    projectRoot: string,
  ) {
    return {
      analysisType,
      source: 'send_to_inspector_tool',
      userRequest: String(userRequest || ''),
      runtimeVersion: process.env.npm_package_version,
      client: {
        hostname: os.hostname(),
        bundleDir: path.relative(projectRoot, bundleDir).replace(/\\/g, '/'),
      },
      manifestPath: path.join(bundleDir, 'manifest.json'),
      caseMarkdownPath: path.join(bundleDir, 'case.md'),
      files: files.map(file => ({
        sourcePath: file.absolutePath,
        kind: file.kind,
        uploadPath: file.relativePath,
      })),
    };
  }

  private async uploadBundle(payload: any, bundleDir: string): Promise<any> {
    const serverUrl = getInspectorServerUrl();
    if (!serverUrl) {
      throw new Error('INSPECTOR_SERVER_URL is not set');
    }

    const requestBody = {
      analysisType: payload.analysisType,
      source: payload.source,
      userRequest: payload.userRequest,
      runtimeVersion: payload.runtimeVersion,
      client: payload.client,
      manifest: JSON.parse(fs.readFileSync(payload.manifestPath, 'utf-8')),
      caseMarkdown: fs.readFileSync(payload.caseMarkdownPath, 'utf-8'),
      files: [],
    };

    const endpoint = this.normalizeCasesEndpoint(serverUrl);
    const response = await this.postJson(endpoint, requestBody, process.env.INSPECTOR_SERVER_API_KEY?.trim());
    const caseId = String(response.caseId || '').trim();
    if (!caseId) {
      throw new Error('Inspector response missing caseId');
    }

    for (const file of payload.files) {
      await this.uploadFile(`${endpoint}/${encodeURIComponent(caseId)}/files`, file, process.env.INSPECTOR_SERVER_API_KEY?.trim());
    }

    fs.writeFileSync(path.join(bundleDir, 'upload-result.json'), JSON.stringify(response, null, 2), 'utf-8');
    return response;
  }

  private normalizeCasesEndpoint(serverUrl: string): string {
    const trimmed = serverUrl.replace(/\/+$/, '');
    return trimmed.endsWith('/api/inspector/cases')
      ? trimmed
      : `${trimmed}/api/inspector/cases`;
  }

  private async postJson(endpoint: string, body: unknown, apiKey?: string): Promise<any> {
    const url = new URL(endpoint);
    const data = JSON.stringify(body);
    const client = url.protocol === 'https:' ? https : http;

    return await new Promise((resolve, reject) => {
      const req = client.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
            ...(apiKey ? { 'x-inspector-key': apiKey } : {}),
          },
        },
        res => {
          let responseBody = '';
          res.setEncoding('utf-8');
          res.on('data', chunk => {
            responseBody += chunk;
          });
          res.on('end', () => {
            if ((res.statusCode || 500) >= 400) {
              return reject(new Error(`HTTP ${res.statusCode}: ${responseBody}`));
            }
            try {
              resolve(JSON.parse(responseBody || '{}'));
            } catch (error: any) {
              reject(new Error(`Invalid JSON response: ${error.message}`));
            }
          });
        },
      );

      req.on('error', reject);
      req.setTimeout(60_000, () => {
        req.destroy(new Error('Inspector upload timed out'));
      });
      req.write(data);
      req.end();
    });
  }

  private async uploadFile(
    endpoint: string,
    file: { sourcePath: string; kind: string; uploadPath: string },
    apiKey?: string,
  ): Promise<any> {
    const url = new URL(endpoint);
    const fileBuffer = fs.readFileSync(file.sourcePath);
    const boundary = `----xiaoba-inspector-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
    const multipartBody = this.buildMultipartBody(boundary, file, fileBuffer);
    const client = url.protocol === 'https:' ? https : http;

    return await new Promise((resolve, reject) => {
      const req = client.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': multipartBody.length,
            ...(apiKey ? { 'x-inspector-key': apiKey } : {}),
          },
        },
        res => {
          let responseBody = '';
          res.setEncoding('utf-8');
          res.on('data', chunk => {
            responseBody += chunk;
          });
          res.on('end', () => {
            if ((res.statusCode || 500) >= 400) {
              return reject(new Error(`HTTP ${res.statusCode}: ${responseBody}`));
            }
            try {
              resolve(JSON.parse(responseBody || '{}'));
            } catch (error: any) {
              reject(new Error(`Invalid JSON response: ${error.message}`));
            }
          });
        },
      );

      req.on('error', reject);
      req.setTimeout(60_000, () => {
        req.destroy(new Error('Inspector upload timed out'));
      });
      req.write(multipartBody);
      req.end();
    });
  }

  private buildMultipartBody(
    boundary: string,
    file: { sourcePath: string; kind: string; uploadPath: string },
    fileBuffer: Buffer,
  ): Buffer {
    const parts: Buffer[] = [];
    const pushField = (name: string, value: string) => {
      parts.push(Buffer.from(`--${boundary}\r\n`));
      parts.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
      parts.push(Buffer.from(value));
      parts.push(Buffer.from('\r\n'));
    };

    pushField('path', file.uploadPath);
    if (file.kind) {
      pushField('kind', file.kind);
    }

    const filename = path.basename(file.sourcePath);
    parts.push(Buffer.from(`--${boundary}\r\n`));
    parts.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`));
    parts.push(Buffer.from('Content-Type: application/octet-stream\r\n\r\n'));
    parts.push(fileBuffer);
    parts.push(Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    return Buffer.concat(parts);
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
}
