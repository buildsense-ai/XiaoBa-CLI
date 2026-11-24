import { execFile } from 'node:child_process';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { Tool, ToolDefinition, ToolExecutionResult } from '../types/tool';
import { getMachineResourceSnapshot, isMachineResourcesDisabled } from '../utils/machine-resources';

const execFileAsync = promisify(execFile);

function nvidiaSmiPaths(): string[] {
  if (process.platform === 'linux') {
    return ['/usr/bin/nvidia-smi', '/usr/local/nvidia/bin/nvidia-smi', '/usr/lib/wsl/lib/nvidia-smi'];
  }
  if (process.platform === 'win32') {
    return [
      process.env.SystemRoot && join(process.env.SystemRoot, 'System32', 'nvidia-smi.exe'),
      process.env.ProgramFiles && join(process.env.ProgramFiles, 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'),
    ].filter((candidate): candidate is string => Boolean(candidate && isAbsolute(candidate)));
  }
  return [];
}

interface NvidiaGpu {
  name: string;
  totalMemoryMiB: number | null;
  freeMemoryMiB: number | null;
}

async function readNvidiaGpus(): Promise<NvidiaGpu[] | null> {
  for (const binary of nvidiaSmiPaths()) {
    try {
      const { stdout } = await execFileAsync(binary, [
        '--query-gpu=name,memory.total,memory.free',
        '--format=csv,noheader,nounits',
      ], { cwd: dirname(binary), timeout: 1200, maxBuffer: 65536, windowsHide: true });
      const devices: NvidiaGpu[] = [];
      for (const line of stdout.trim().split(/\r?\n/)) {
        const match = /^(.+),\s*(\d+|\[?N\/A\]?),\s*(\d+|\[?N\/A\]?)$/.exec(line.trim());
        if (!match) return null;
        devices.push({
          name: match[1].trim(),
          totalMemoryMiB: /^\d+$/.test(match[2]) ? Number(match[2]) : null,
          freeMemoryMiB: /^\d+$/.test(match[3]) ? Number(match[3]) : null,
        });
      }
      return devices;
    } catch {
      // Driver tooling is optional and can live in different system directories.
    }
  }
  return null;
}

export class LocalComputeResourcesTool implements Tool {
  readonly definition: ToolDefinition = {
    name: 'local_compute_resources',
    description: '资源密集型任务开始前，查询当前 Agent 运行设备的 CPU、内存和可探测的 NVIDIA GPU，用于判断能否在此设备执行并与云端方案比较。返回带采样时间的事实，null 表示未检测到可靠数据。',
    parameters: { type: 'object', properties: {} },
  };

  async execute(args: unknown): Promise<ToolExecutionResult> {
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) {
      return { ok: false, errorCode: 'INVALID_TOOL_ARGUMENTS', message: '此工具参数为 {}。' };
    }
    if (isMachineResourcesDisabled()) {
      return { ok: false, errorCode: 'MACHINE_RESOURCES_DISABLED', message: '当前运行设备已关闭机况采样。' };
    }

    const nvidiaGpus = await readNvidiaGpus();
    const snapshot = getMachineResourceSnapshot();
    return {
      ok: true,
      content: JSON.stringify({
        scope: 'agent_runtime',
        platform: snapshot.platform,
        cpuLogicalCount: snapshot.cpuCount,
        totalMemoryBytes: snapshot.totalMemoryBytes ?? null,
        availableMemoryBytes: snapshot.availableMemoryBytes ?? null,
        loadAverage1m: snapshot.platform === 'win32' ? null : snapshot.load1 ?? null,
        sampledAt: new Date(snapshot.sampledAt).toISOString(),
        nvidiaGpus,
      }),
    };
  }
}
