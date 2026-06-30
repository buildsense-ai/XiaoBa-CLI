import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { executeRouteIfRemote, resolveExecutionRoute, targetParameterDescription } from './execution-router';

export type CommonDirectoryKind =
  | 'desktop'
  | 'downloads'
  | 'documents'
  | 'pictures'
  | 'videos'
  | 'music'
  | 'home'
  | 'temp';

export interface DirectoryResolution {
  kind: CommonDirectoryKind;
  path: string;
  source: string;
  exists: boolean;
  platform: NodeJS.Platform;
}

const DIRECTORY_ALIASES: Record<string, CommonDirectoryKind> = {
  desktop: 'desktop',
  mydesktop: 'desktop',
  desktopfolder: 'desktop',
  '\u684c\u9762': 'desktop',

  downloads: 'downloads',
  download: 'downloads',
  mydownloads: 'downloads',
  downloadsfolder: 'downloads',
  downloadfolder: 'downloads',
  '\u4e0b\u8f7d': 'downloads',
  '\u4e0b\u8f7d\u6587\u4ef6\u5939': 'downloads',

  documents: 'documents',
  document: 'documents',
  docs: 'documents',
  mydocuments: 'documents',
  documentsfolder: 'documents',
  '\u6587\u6863': 'documents',

  pictures: 'pictures',
  picture: 'pictures',
  photos: 'pictures',
  photo: 'pictures',
  images: 'pictures',
  image: 'pictures',
  mypictures: 'pictures',
  picturesfolder: 'pictures',
  '\u56fe\u7247': 'pictures',
  '\u7167\u7247': 'pictures',

  videos: 'videos',
  video: 'videos',
  movies: 'videos',
  movie: 'videos',
  myvideos: 'videos',
  videosfolder: 'videos',
  '\u89c6\u9891': 'videos',

  music: 'music',
  mymusic: 'music',
  musicfolder: 'music',
  '\u97f3\u4e50': 'music',

  home: 'home',
  user: 'home',
  userhome: 'home',
  homedir: 'home',
  '\u7528\u6237\u76ee\u5f55': 'home',
  '\u4e3b\u76ee\u5f55': 'home',

  temp: 'temp',
  tmp: 'temp',
  '\u4e34\u65f6\u76ee\u5f55': 'temp',
  '\u4e34\u65f6\u6587\u4ef6\u5939': 'temp',
};

const WINDOWS_REGISTRY_VALUES: Partial<Record<CommonDirectoryKind, string>> = {
  desktop: 'Desktop',
  downloads: '{374DE290-123F-4565-9164-39C4925E467B}',
  documents: 'Personal',
  pictures: 'My Pictures',
  videos: 'My Video',
  music: 'My Music',
};

const STANDARD_SUBDIRECTORIES: Record<Exclude<CommonDirectoryKind, 'home' | 'temp'>, string> = {
  desktop: 'Desktop',
  downloads: 'Downloads',
  documents: 'Documents',
  pictures: 'Pictures',
  videos: process.platform === 'darwin' ? 'Movies' : 'Videos',
  music: 'Music',
};

const XDG_KEYS: Partial<Record<CommonDirectoryKind, string>> = {
  desktop: 'XDG_DESKTOP_DIR',
  downloads: 'XDG_DOWNLOAD_DIR',
  documents: 'XDG_DOCUMENTS_DIR',
  pictures: 'XDG_PICTURES_DIR',
  videos: 'XDG_VIDEOS_DIR',
  music: 'XDG_MUSIC_DIR',
};

export function normalizeCommonDirectory(input: string): CommonDirectoryKind | null {
  const normalized = input.trim().toLowerCase().replace(/[\s_-]+/g, '');
  return DIRECTORY_ALIASES[normalized] ?? null;
}

export function resolveCommonDirectory(kind: CommonDirectoryKind): DirectoryResolution {
  if (kind === 'home') {
    return buildResolution(kind, os.homedir(), 'os_homedir');
  }
  if (kind === 'temp') {
    return buildResolution(kind, os.tmpdir(), 'os_tmpdir');
  }

  if (process.platform === 'win32') {
    const registryPath = readWindowsKnownFolder(kind);
    if (registryPath) {
      return buildResolution(kind, registryPath, 'windows_user_shell_folders');
    }
  }

  if (process.platform === 'linux') {
    const xdgPath = readLinuxXdgUserDir(kind);
    if (xdgPath) {
      return buildResolution(kind, xdgPath, 'linux_xdg_user_dirs');
    }
  }

  return buildResolution(kind, path.join(os.homedir(), STANDARD_SUBDIRECTORIES[kind]), 'home_fallback');
}

export class CommonDirectoryTool implements Tool {
  definition: ToolDefinition = {
    name: 'resolve_common_directory',
    description: [
      '把常见用户目录名称解析为当前工具目标设备上的真实本地路径。',
      '当用户说“桌面”“下载”“文档”等自然语言目录时先用它解析，不要手猜 C:\\Users\\...\\Desktop、~/Desktop 等路径。',
      '解析出的 path 只属于本次工具实际执行的目标：可能是虚拟员工自己的云运行体，也可能是后端选中的用户设备。',
      '解析后如果要查看目录文件，请用 glob；如果要创建文件，请用 write_file。必须用命令时，把 path 传给 execute_shell.cwd，不要单独 cd 后再猜当前目录。',
      '只解析标准 OS 用户目录；不搜索项目目录、应用目录、浏览器下载子目录或语义目录。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: '要解析的目录名。支持 desktop, downloads, documents, pictures, videos, music, home, temp 及常见中文别名。',
        },
        target: targetParameterDescription(),
      },
      required: ['directory'],
    },
  };

  async execute(args: any, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const input = typeof args?.directory === 'string' ? args.directory : '';
    const kind = normalizeCommonDirectory(input);
    if (!kind) {
      return invalidCommonDirectoryResult(input);
    }

    const route = resolveExecutionRoute(_context, {
      toolName: 'resolve_common_directory',
      operation: 'resolve_common_directory',
      target: args.target,
    });
    if (!route.ok) return { ok: false, errorCode: route.errorCode, message: route.message };

    const remote = await executeRouteIfRemote(
      _context,
      route,
      'resolve_common_directory',
      'resolve_common_directory',
      { directory: kind },
    );
    if (remote) return remote;

    return resolveCommonDirectoryToolArgs({ directory: kind });
  }
}

export function resolveCommonDirectoryToolArgs(args: any): ToolExecutionResult {
  const input = typeof args?.directory === 'string' ? args.directory : '';
  const kind = normalizeCommonDirectory(input);
  if (!kind) return invalidCommonDirectoryResult(input);
  return {
    ok: true,
    content: formatCommonDirectoryResolution(resolveCommonDirectory(kind)),
  };
}

export function formatCommonDirectoryResolution(result: DirectoryResolution): string {
  return [
    'Resolved common directory:',
    `kind: ${result.kind}`,
    `path: ${result.path}`,
    `source: ${result.source}`,
    `exists: ${result.exists}`,
    `platform: ${result.platform}`,
    '',
    'Use this exact path only with the same tool target that produced this result.',
    'If the next user request switches between "my/user computer" and "your/virtual employee cloud computer", call resolve_common_directory again on the new target.',
    'To list files here, call glob with this path and an appropriate pattern such as "*".',
    'To create or overwrite a text file here, call write_file with a file_path under this path.',
    'If shell is truly required, pass this path as execute_shell.cwd instead of relying on a prior cd command.',
    'Do not use execute_shell for routine file listing or file creation.',
  ].join('\n');
}

function invalidCommonDirectoryResult(input: string): ToolExecutionResult {
  return {
    ok: false,
    errorCode: 'INVALID_TOOL_ARGUMENTS',
    message: `Unknown common directory: ${input || '(empty)'}\nSupported: desktop, downloads, documents, pictures, videos, music, home, temp`,
  };
}

function buildResolution(kind: CommonDirectoryKind, directoryPath: string, source: string): DirectoryResolution {
  const resolvedPath = path.resolve(directoryPath);
  return {
    kind,
    path: resolvedPath,
    source,
    exists: fs.existsSync(resolvedPath),
    platform: process.platform,
  };
}

function readWindowsKnownFolder(kind: CommonDirectoryKind): string | null {
  const valueName = WINDOWS_REGISTRY_VALUES[kind];
  if (!valueName) return null;

  const command = [
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
    '$key = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders"',
    `$value = (Get-ItemProperty -LiteralPath $key -Name '${valueName}' -ErrorAction SilentlyContinue).'${valueName}'`,
    'if ($value) { [Environment]::ExpandEnvironmentVariables([string]$value) }',
  ].join('; ');

  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', command], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

function readLinuxXdgUserDir(kind: CommonDirectoryKind): string | null {
  const key = XDG_KEYS[kind];
  if (!key) return null;

  const configPath = path.join(os.homedir(), '.config', 'user-dirs.dirs');
  if (!fs.existsSync(configPath)) return null;

  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const match = content.match(new RegExp(`^${key}=(?:"([^"]*)"|'([^']*)'|([^\\n#]*))`, 'm'));
    const rawValue = match?.[1] ?? match?.[2] ?? match?.[3];
    if (!rawValue) return null;
    const expanded = rawValue
      .trim()
      .replace(/^\$HOME(?=\/|$)/, os.homedir())
      .replace(/^\$\{HOME\}(?=\/|$)/, os.homedir());
    return expanded || null;
  } catch {
    return null;
  }
}
