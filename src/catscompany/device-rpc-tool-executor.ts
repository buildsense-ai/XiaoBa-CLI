import type { ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import type { DeviceRpcToolRegistration, DeviceRpcToolName } from '../tools/device-rpc-registry';
import { ReadTool } from '../tools/read-tool';
import { GlobTool } from '../tools/glob-tool';
import { GrepTool } from '../tools/grep-tool';
import { WriteTool } from '../tools/write-tool';
import { EditTool } from '../tools/edit-tool';
import { SendFileTool } from '../tools/send-file-tool';
import { ShellTool } from '../tools/bash-tool';
import { resolveCommonDirectoryToolArgs } from '../tools/common-directory-tool';

type DeviceRpcLocalExecutor = (
  args: Record<string, unknown>,
  context: ToolExecutionContext,
) => Promise<ToolExecutionResult> | ToolExecutionResult;

const LOCAL_DEVICE_RPC_EXECUTORS: Record<DeviceRpcToolName, DeviceRpcLocalExecutor> = {
  read_file: (args, context) => new ReadTool().execute(args, context),
  resolve_common_directory: args => resolveCommonDirectoryToolArgs(args),
  glob: (args, context) => new GlobTool().execute(args, context),
  grep: (args, context) => new GrepTool().execute(args, context),
  write_file: (args, context) => new WriteTool().execute(args, context),
  edit_file: (args, context) => new EditTool().execute(args, context),
  send_file: (args, context) => new SendFileTool().execute(args, context),
  execute_shell: (args, context) => new ShellTool().execute(args, context),
};

export async function executeRegisteredDeviceRpcTool(
  registration: DeviceRpcToolRegistration,
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const executor = LOCAL_DEVICE_RPC_EXECUTORS[registration.toolName];
  if (!executor) {
    return {
      ok: false,
      errorCode: 'PERMISSION_DENIED',
      message: `Device RPC 不允许执行 ${registration.toolName}。`,
    };
  }
  return executor(args, context);
}
