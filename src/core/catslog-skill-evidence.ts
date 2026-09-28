import { isMemoryCitationRef } from '../tools/memory-branch-tools';

/**
 * Minimal anti-hallucination guard for memory-branch finishes (thin v1).
 *
 * The tracker collects only citation-shaped refs that actually appeared in
 * this run's tool results. A finish ref that was never observed cannot be
 * delivered to the parent as context; it is retained as audit-only evidence
 * instead. Tool result text never enters the tracker.
 */

export const MAX_OBSERVED_REFS = 128;
const MAX_WALK_DEPTH = 6;
const MAX_WALK_ARRAY = 64;
const MAX_REF_CHARS = 512;

export interface CatsLogObservedRefsSnapshot {
  schema: 'catslog.branch.observed-refs.v1';
  observedRefs: string[];
}

export class CatsLogObservedRefsTracker {
  private readonly observed = new Set<string>();

  /** Absorb one projected tool result. Malformed JSON is ignored. */
  recordToolResult(_name: string, result: string): void {
    if (typeof result !== 'string' || result.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(result);
    } catch {
      return;
    }
    this.collect(parsed, 0);
  }

  /**
   * Return the cited refs that were never observed in this run's tool
   * results. An empty result means the finish may proceed to parent context.
   */
  unobservedRefs(refs: readonly string[]): string[] {
    const list = Array.isArray(refs) ? refs : [];
    return Array.from(new Set(list)).filter(ref => !this.observed.has(ref));
  }

  snapshot(): CatsLogObservedRefsSnapshot {
    return {
      schema: 'catslog.branch.observed-refs.v1',
      observedRefs: Array.from(this.observed).slice(0, MAX_OBSERVED_REFS),
    };
  }

  private collect(value: unknown, depth: number): void {
    if (this.observed.size >= MAX_OBSERVED_REFS) return;
    if (typeof value === 'string') {
      // The tool projections already hash unsafe refs into
      // `catslog:ref:<hash>`, so anything citation-shaped here is a ref the
      // branch can legitimately cite.
      if (value.length <= MAX_REF_CHARS && isMemoryCitationRef(value)) {
        this.observed.add(value);
      }
      return;
    }
    if (depth >= MAX_WALK_DEPTH || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, MAX_WALK_ARRAY)) {
        this.collect(item, depth + 1);
        if (this.observed.size >= MAX_OBSERVED_REFS) return;
      }
      return;
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
      this.collect(child, depth + 1);
      if (this.observed.size >= MAX_OBSERVED_REFS) return;
    }
  }
}
