import { ToolExecutionContext } from '../types/tool';

/**
 * Merge tool execution context without letting undefined override a live value.
 *
 * This keeps cancellation and channel callbacks intact when a caller passes a
 * partial override object with optional fields left undefined.
 */
export function mergeToolExecutionContext(
  base: Partial<ToolExecutionContext>,
  overrides?: Partial<ToolExecutionContext>,
): ToolExecutionContext {
  const merged: Record<string, unknown> = { ...base };
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) {
        merged[key] = value;
      }
    }
  }
  return merged as unknown as ToolExecutionContext;
}
