/**
 * MCP 远端工具 Schema 与 annotations 提取工具。
 *
 * 设计要点：
 * - **完整保留 inputSchema**：`anyOf` / `oneOf` / `allOf` / `additionalProperties` /
 *   `$defs` / `$ref` / 嵌套 objects/arrays 全部原样保留，只在递归地做防御性拷贝时
 *   剔除明显非 JSON-Schema 的宿主注入字段（函数、undefined）。下游 provider 用同一份
 *   JSON Schema 做校验/生成，丢字段会直接削弱模型对复杂工具的调用能力。
 * - **provider-compat sanitizer**：个别 provider 只支持严格子集时，调用方可用
 *   `sanitizeSchemaForProvider()` 显式裁剪 —— 收敛行为由调用方显式选择，不再默认丢信息。
 * - **annotations / icons 提取**：MCP tool annotations
 *   （title / readOnlyHint / destructiveHint / idempotentHint / openWorldHint）
 *   与 icons 元数据提取成稳定结构体，供 XiaoBa 风险/审批层与 UI 直接消费。
 */

/** MCP Tool annotations（spec 2025-06-18+，全部可选）。 */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 递归深拷贝 JSON Schema，丢弃函数/undefined（不可序列化的宿主注入），
 * 其余一律原样保留 —— 包括 anyOf/oneOf/allOf/$defs/$ref/additionalProperties/
 * patternProperties/const/format/minItems 等任意规范字段与未知扩展字段。
 */
function deepCopyJsonSchemaValue(value: unknown): unknown {
  if (value === undefined || typeof value === 'function') return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value
      .map(item => deepCopyJsonSchemaValue(item))
      .filter(item => item !== undefined);
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const copied = deepCopyJsonSchemaValue(item);
    if (copied !== undefined) out[key] = copied;
  }
  return out;
}

/**
 * 完整保留远端 inputSchema。
 * 返回值保证是 object 形态（parameters.type === 'object' 的根），非对象输入
 * 降级为 `{ type: 'object', properties: {} }`。
 */
export function preserveFullInputSchema(schema: unknown): Record<string, unknown> {
  if (!isPlainObject(schema)) {
    return { type: 'object', properties: {} };
  }
  const copied = deepCopyJsonSchemaValue(schema);
  if (!isPlainObject(copied)) {
    return { type: 'object', properties: {} };
  }
  if (typeof copied.type !== 'string') copied.type = 'object';
  if (!isPlainObject(copied.properties)) copied.properties = {};
  return copied;
}

/** provider 兼容裁剪档位：strict 只保留最低公分母字段。 */
export type ProviderSchemaCompatMode = 'strict';

const STRICT_PARAMETER_KEYS = new Set([
  'type',
  'description',
  'enum',
  'items',
  'properties',
  'required',
  'default',
]);

/**
 * 为只支持严格 JSON Schema 子集的 provider 裁剪 schema。
 * - properties/items 递归收敛；
 * - anyOf/oneOf/allOf/$defs/$ref/additionalProperties 等在 strict 模式下被移除；
 * - 输入不被修改，始终返回新对象。
 *
 * 这是**显式 opt-in** 的兼容助手 —— 默认路径请用 `preserveFullInputSchema`。
 */
export function sanitizeSchemaForProvider(
  schema: unknown,
  _mode: ProviderSchemaCompatMode = 'strict',
): Record<string, unknown> {
  const sanitizeNode = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(sanitizeNode);
    if (!isPlainObject(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (!STRICT_PARAMETER_KEYS.has(key)) continue;
      if (key === 'properties' && isPlainObject(value)) {
        const nested: Record<string, unknown> = {};
        for (const [propKey, propValue] of Object.entries(value)) {
          const sanitized = sanitizeNode(propValue);
          if (isPlainObject(sanitized)) nested[propKey] = sanitized;
        }
        out.properties = nested;
        continue;
      }
      if (key === 'items') {
        out.items = sanitizeNode(value);
        continue;
      }
      if (key === 'required' && Array.isArray(value)) {
        out.required = value.filter((item): item is string => typeof item === 'string');
        continue;
      }
      if (key === 'enum' && Array.isArray(value)) {
        const values = value.filter((item): item is string => typeof item === 'string');
        if (values.length > 0) out.enum = values;
        continue;
      }
      out[key] = sanitizeNode(value);
    }
    return out;
  };

  const root = isPlainObject(schema) ? schema : {};
  const sanitized = sanitizeNode(root);
  const result = isPlainObject(sanitized) ? sanitized : {};
  if (typeof result.type !== 'string') result.type = 'object';
  if (!isPlainObject(result.properties)) result.properties = {};
  return result;
}

/**
 * 提取 MCP tool annotations。非法类型字段一律忽略（容忍服务端发错类型，
 * 绝不因为一条怪 annotation 让整个工具注册失败）。
 */
export function extractToolAnnotations(raw: unknown): McpToolAnnotations | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: McpToolAnnotations = {};
  if (typeof raw.title === 'string' && raw.title.trim()) out.title = raw.title.trim();
  for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 提取 MCP tool icons 元数据（spec 2025-11 draft：icons: [{src, mimeType?, sizes?}]）。 */
export function extractToolIcons(raw: unknown): McpToolIcon[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const icons: McpToolIcon[] = [];
  for (const item of raw) {
    if (!isPlainObject(item) || typeof item.src !== 'string' || !item.src.trim()) continue;
    const icon: McpToolIcon = { src: item.src.trim() };
    if (typeof item.mimeType === 'string' && item.mimeType.trim()) icon.mimeType = item.mimeType.trim();
    if (Array.isArray(item.sizes)) {
      const sizes = item.sizes.filter((size): size is string => typeof size === 'string' && size.trim().length > 0);
      if (sizes.length > 0) icon.sizes = sizes;
    }
    icons.push(icon);
  }
  return icons.length > 0 ? icons : undefined;
}
