import { AsyncLocalStorage } from 'node:async_hooks';
import type { ModelAttemptEvent, ModelAttemptSink } from '../providers/provider';

const scopedSinks = new AsyncLocalStorage<readonly ModelAttemptSink[]>();

/**
 * Adds an in-memory observer to every AIService call created in this async
 * scope, including branch/subagent calls that do not know about the caller.
 * Explicit request sinks keep running alongside scoped observers.
 */
export function withModelAttemptSink<T>(
  sink: ModelAttemptSink,
  operation: () => T,
): T {
  const current = scopedSinks.getStore() ?? [];
  return scopedSinks.run([...current, sink], operation);
}

export function resolveModelAttemptSink(
  explicit?: ModelAttemptSink,
): ModelAttemptSink | undefined {
  const sinks = uniqueSinks([
    ...(explicit ? [explicit] : []),
    ...(scopedSinks.getStore() ?? []),
  ]);
  if (sinks.length === 0) return undefined;
  if (sinks.length === 1) return sinks[0];
  const critical = sinks.filter(sink => sink.critical === true);
  const diagnostic = sinks.filter(sink => sink.critical !== true);
  return {
    critical: critical.length > 0,
    observe(event: ModelAttemptEvent): void {
      for (const sink of critical) {
        const result = sink.observe(event);
        if (result && typeof (result as Promise<void>).then === 'function') {
          throw new Error('critical_model_attempt_sink_must_be_synchronous');
        }
      }
      for (const sink of diagnostic) {
        try {
          const result = sink.observe(event);
          if (result && typeof (result as Promise<void>).then === 'function') {
            Promise.resolve(result).catch(() => undefined);
          }
        } catch {
          // Observability must never affect the provider call.
        }
      }
    },
  };
}

function uniqueSinks(sinks: readonly ModelAttemptSink[]): ModelAttemptSink[] {
  const seen = new Set<ModelAttemptSink>();
  const result: ModelAttemptSink[] = [];
  for (const sink of sinks) {
    if (seen.has(sink)) continue;
    seen.add(sink);
    result.push(sink);
  }
  return result;
}
