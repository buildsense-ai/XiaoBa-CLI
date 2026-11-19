import type { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';

export class RequestDeviceAccessTool implements Tool {
  definition: ToolDefinition = {
    name: 'request_device_access',
    controlMode: 'pause_turn',
    description: '在当前 CatsCo 群中向另一位真人申请设备使用权。尚未共享时使用本工具发出授权卡片，由设备所有者选择设备并批准。工具只能申请，不能批准、执行或代替用户授权。许可获批后等待用户下一轮消息再执行。',
    parameters: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: '设备所有者在本群的名字或 usr UID，必须唯一对应真人。' },
        description: { type: 'string', description: '请求使用的电脑名称及用途，供所有者确认。' },
      },
      required: ['owner', 'description'],
    },
  };

  constructor(private readonly send: (payload: Record<string, unknown>) => Promise<unknown>) {}

  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const scope = context.executionScope;
    if (!scope || scope.source !== 'catscompany' || scope.topicType !== 'group'
      || scope.identityTrust !== 'server_canonical' || !scope.channelSeq) {
      return { ok: false, errorCode: 'PERMISSION_DENIED', message: '只能从当前群内的可信用户消息发起设备申请。' };
    }
    const owner = String(args.owner || '').trim();
    if (!owner || owner.length > 200) {
      return { ok: false, errorCode: 'INVALID_TOOL_ARGUMENTS', message: '请指定本群中的真人设备所有者。' };
    }
    const description = String(args.description || '').trim();
    if (!description || description.length > 2000) {
      return { ok: false, errorCode: 'INVALID_TOOL_ARGUMENTS', message: '请提供不超过 2000 字的设备和用途说明。' };
    }
    try {
      await this.send({
        action: 'create', topic_id: scope.topicId, message_id: scope.channelSeq,
        owner,
        client_request_id: `share-${scope.channelSeq}-${scope.agentId}-${owner}`,
        description,
      });
      return { ok: true, content: '已发送设备授权申请卡片。请等待设备所有者选择设备并批准，获批后由用户发送下一轮指令。' };
    } catch {
      return { ok: false, errorCode: 'PERMISSION_DENIED', message: '申请未获服务端确认。请让用户确认所有者在本群的名字或 UID，或刷新群聊核对卡片；不要通过搜索本地文件推测账号。' };
    }
  }
}
