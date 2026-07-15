/**
 * Issue #94 — Strict rendered Timeline parser for the official xURL agents://
 * reader contract (ADR-0043). These tests validate the release-gate parser
 * that #90 will wire into the reader. They pass now against the standalone
 * parser module and will continue to pass after #90–#93 integrate because
 * they test the Timeline contract, not the reader wiring.
 *
 * Adversarial cases covered:
 *   - frontmatter spoofing (wrong provider / thread)
 *   - duplicate ordinals
 *   - non-monotonic ordinals
 *   - malformed / unsupported roles
 *   - heading-shaped message content (residual ambiguity)
 *   - oversized output
 *   - incomplete tail (User without matching Assistant)
 *   - empty / non-Markdown output
 *   - missing frontmatter
 */
import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  parseRenderedTimeline,
  MAX_RENDERED_TIMELINE_BYTES,
  type RenderedTimelineEvent,
  type RenderedTimelineParseResult,
} from '../src/utils/xurl-rendered-timeline';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validTimeline(opts: {
  provider?: string;
  thread?: string;
  branch?: string;
  entries?: Array<{ role: string; content: string }>;
}): string {
  const provider = opts.provider ?? 'codex';
  const thread = opts.thread ?? 'thread-001';
  const branch = opts.branch ? `\nbranch: ${opts.branch}` : '';
  const entries = opts.entries ?? [
    { role: 'User', content: 'Fix the login bug.' },
    { role: 'Assistant', content: 'I updated the auth check.' },
  ];
  const body = entries
    .map((entry, i) => `### ${i + 1}. ${entry.role}\n\n${entry.content}`)
    .join('\n\n');
  return `---\nuri: agents://${provider}/${thread}\nprovider: ${provider}\nthread: ${thread}${branch}\n---\n\n## Thread\n\n${thread}\n\n## Timeline\n\n${body}\n`;
}

// ---------------------------------------------------------------------------
// Valid parsing
// ---------------------------------------------------------------------------

describe('rendered Timeline parser — valid documents', () => {
  test('parses a minimal User→Assistant turn into one canonical event', () => {
    const markdown = validTimeline({});
    const result = parseRenderedTimeline(markdown, 'codex', 'thread-001');
    assert.equal(result.provider, 'codex');
    assert.equal(result.thread, 'thread-001');
    assert.equal(result.events.length, 1);
    const event = result.events[0]!;
    assert.equal(event.ordinalStart, 1);
    assert.equal(event.ordinalEnd, 2);
    assert.equal(event.roles.length, 2);
    assert.equal(event.roles[0]!.role, 'User');
    assert.equal(event.roles[0]!.content, 'Fix the login bug.');
    assert.equal(event.roles[1]!.role, 'Assistant');
    assert.equal(event.roles[1]!.content, 'I updated the auth check.');
    assert.ok(event.contentHash.length > 0, 'contentHash must be non-empty');
    assert.ok(event.identity.length > 0, 'identity must be non-empty');
  });

  test('parses two User→Assistant turns into two canonical events', () => {
    const markdown = validTimeline({
      entries: [
        { role: 'User', content: 'First request.' },
        { role: 'Assistant', content: 'First response.' },
        { role: 'User', content: 'Second request.' },
        { role: 'Assistant', content: 'Second response.' },
      ],
    });
    const result = parseRenderedTimeline(markdown, 'codex', 'thread-001');
    assert.equal(result.events.length, 2);
    assert.equal(result.events[0]!.ordinalStart, 1);
    assert.equal(result.events[0]!.ordinalEnd, 2);
    assert.equal(result.events[1]!.ordinalStart, 3);
    assert.equal(result.events[1]!.ordinalEnd, 4);
  });

  test('Context Compacted entries are included as bounded context within the event', () => {
    const markdown = validTimeline({
      entries: [
        { role: 'Context Compacted', content: 'Prior context about the auth module.' },
        { role: 'User', content: 'Fix the login bug.' },
        { role: 'Assistant', content: 'I updated the auth check.' },
      ],
    });
    const result = parseRenderedTimeline(markdown, 'codex', 'thread-001');
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]!.roles.length, 3);
    assert.equal(result.events[0]!.roles[0]!.role, 'Context Compacted');
  });

  test('records branch identity when present in frontmatter', () => {
    const markdown = validTimeline({ branch: 'feature-branch' });
    const result = parseRenderedTimeline(markdown, 'codex', 'thread-001');
    assert.equal(result.branch, 'feature-branch');
    assert.ok(result.events[0]!.identity.includes('feature-branch'));
  });

  test('contentHash is deterministic for identical normalized content', () => {
    const md1 = validTimeline({});
    const md2 = validTimeline({});
    const r1 = parseRenderedTimeline(md1, 'codex', 'thread-001');
    const r2 = parseRenderedTimeline(md2, 'codex', 'thread-001');
    assert.equal(r1.events[0]!.contentHash, r2.events[0]!.contentHash);
  });

  test('contentHash differs when content differs', () => {
    const md1 = validTimeline({
      entries: [
        { role: 'User', content: 'Fix the login bug.' },
        { role: 'Assistant', content: 'I updated the auth check.' },
      ],
    });
    const md2 = validTimeline({
      entries: [
        { role: 'User', content: 'Fix the login bug.' },
        { role: 'Assistant', content: 'I updated the auth check differently.' },
      ],
    });
    const r1 = parseRenderedTimeline(md1, 'codex', 'thread-001');
    const r2 = parseRenderedTimeline(md2, 'codex', 'thread-001');
    assert.notEqual(r1.events[0]!.contentHash, r2.events[0]!.contentHash);
  });
});

// ---------------------------------------------------------------------------
// Frontmatter validation
// ---------------------------------------------------------------------------

describe('rendered Timeline parser — frontmatter spoofing', () => {
  test('rejects frontmatter provider mismatch', () => {
    const md = validTimeline({ provider: 'codex' });
    assert.throws(
      () => parseRenderedTimeline(md, 'claude', 'thread-001'),
      /provider.*mismatch/i,
    );
  });

  test('rejects frontmatter thread mismatch', () => {
    const md = validTimeline({ thread: 'thread-001' });
    assert.throws(
      () => parseRenderedTimeline(md, 'codex', 'thread-999'),
      /thread.*mismatch/i,
    );
  });

  test('rejects missing frontmatter', () => {
    const md = `## Thread\n\nthread-001\n\n## Timeline\n\n### 1. User\n\nHello\n\n### 2. Assistant\n\nHi\n`;
    assert.throws(
      () => parseRenderedTimeline(md, 'codex', 'thread-001'),
      /frontmatter/i,
    );
  });

  test('rejects frontmatter with no uri', () => {
    const md = `---\nprovider: codex\nthread: thread-001\n---\n\n## Thread\n\nthread-001\n\n## Timeline\n\n### 1. User\n\nHello\n\n### 2. Assistant\n\nHi\n`;
    assert.throws(
      () => parseRenderedTimeline(md, 'codex', 'thread-001'),
      /uri/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Ordinal validation
// ---------------------------------------------------------------------------

describe('rendered Timeline parser — ordinal validation', () => {
  test('rejects duplicate ordinals', () => {
    const md = `---\nuri: agents://codex/thread-001\nprovider: codex\nthread: thread-001\n---\n\n## Thread\n\nthread-001\n\n## Timeline\n\n### 1. User\n\nHello\n\n### 1. Assistant\n\nHi\n`;
    assert.throws(
      () => parseRenderedTimeline(md, 'codex', 'thread-001'),
      /duplicate.*ordinal|ordinal.*duplicate/i,
    );
  });

  test('rejects non-monotonic ordinals (3 before 2)', () => {
    const md = `---\nuri: agents://codex/thread-001\nprovider: codex\nthread: thread-001\n---\n\n## Thread\n\nthread-001\n\n## Timeline\n\n### 1. User\n\nHello\n\n### 3. Assistant\n\nHi\n`;
    assert.throws(
      () => parseRenderedTimeline(md, 'codex', 'thread-001'),
      /non.monotonic|gap|ordinal/i,
    );
  });

  test('rejects ordinals starting above 1', () => {
    const md = `---\nuri: agents://codex/thread-001\nprovider: codex\nthread: thread-001\n---\n\n## Thread\n\nthread-001\n\n## Timeline\n\n### 2. User\n\nHello\n\n### 3. Assistant\n\nHi\n`;
    assert.throws(
      () => parseRenderedTimeline(md, 'codex', 'thread-001'),
      /ordinal.*1|start/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Role validation
// ---------------------------------------------------------------------------

describe('rendered Timeline parser — role validation', () => {
  test('rejects unsupported role', () => {
    const md = validTimeline({
      entries: [
        { role: 'User', content: 'Hello' },
        { role: 'System', content: 'Bad role' },
      ],
    });
    assert.throws(
      () => parseRenderedTimeline(md, 'codex', 'thread-001'),
      /role|unsupported/i,
    );
  });

  test('rejects empty role label', () => {
    const md = `---\nuri: agents://codex/thread-001\nprovider: codex\nthread: thread-001\n---\n\n## Thread\n\nthread-001\n\n## Timeline\n\n### 1. \n\nHello\n`;
    assert.throws(
      () => parseRenderedTimeline(md, 'codex', 'thread-001'),
      /role|empty/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Incomplete tail
// ---------------------------------------------------------------------------

describe('rendered Timeline parser — incomplete tail', () => {
  test('rejects User entry without a following Assistant', () => {
    const md = validTimeline({
      entries: [
        { role: 'User', content: 'Hello' },
      ],
    });
    assert.throws(
      () => parseRenderedTimeline(md, 'codex', 'thread-001'),
      /incomplete|User.*Assistant|pending/i,
    );
  });

  test('rejects two consecutive User entries without an Assistant between them', () => {
    const md = validTimeline({
      entries: [
        { role: 'User', content: 'First' },
        { role: 'User', content: 'Second' },
        { role: 'Assistant', content: 'Response' },
      ],
    });
    assert.throws(
      () => parseRenderedTimeline(md, 'codex', 'thread-001'),
      /consecutive|User.*User|invalid/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Heading-shaped content (residual ambiguity)
// ---------------------------------------------------------------------------

describe('rendered Timeline parser — heading-shaped content', () => {
  test('content with Markdown heading prefix is treated as content, not a new entry', () => {
    const md = validTimeline({
      entries: [
        { role: 'User', content: 'Here is my plan:\n\n# Implementation Notes\n\nDo the thing.' },
        { role: 'Assistant', content: 'I understand the plan.' },
      ],
    });
    const result = parseRenderedTimeline(md, 'codex', 'thread-001');
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]!.roles[0]!.content, 'Here is my plan:\n\n# Implementation Notes\n\nDo the thing.');
  });

  test('content containing Timeline-shaped heading at tail is documented as residual ambiguity', () => {
    // A heading-shaped line like "### 3. User" at the tail of a message
    // cannot be reliably distinguished from a real Timeline entry without a
    // machine-readable xURL contract. The parser treats any line matching the
    // Timeline heading pattern as a new entry boundary, which means this case
    // will be parsed as a new entry — the residual risk accepted by ADR-0043.
    const md = validTimeline({
      entries: [
        { role: 'User', content: 'Let me summarize:\n\n### 3. User\n\nThis looks like a new entry.' },
        { role: 'Assistant', content: 'Acknowledged.' },
      ],
    });
    // The parser will interpret "### 3. User" as a new entry boundary.
    // This is the accepted residual ambiguity — the test documents it.
    assert.throws(
      () => parseRenderedTimeline(md, 'codex', 'thread-001'),
      /incomplete|consecutive|ordinal|role/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Oversized output
// ---------------------------------------------------------------------------

describe('rendered Timeline parser — oversized output', () => {
  test('rejects document exceeding MAX_RENDERED_TIMELINE_BYTES', () => {
    const huge = 'A'.repeat(MAX_RENDERED_TIMELINE_BYTES + 1);
    const md = `---\nuri: agents://codex/thread-001\nprovider: codex\nthread: thread-001\n---\n\n## Thread\n\nthread-001\n\n## Timeline\n\n### 1. User\n\n${huge}\n\n### 2. Assistant\n\nHi\n`;
    assert.throws(
      () => parseRenderedTimeline(md, 'codex', 'thread-001'),
      /oversized|exceed/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Empty / malformed
// ---------------------------------------------------------------------------

describe('rendered Timeline parser — empty and malformed', () => {
  test('rejects empty input', () => {
    assert.throws(
      () => parseRenderedTimeline('', 'codex', 'thread-001'),
      /empty/i,
    );
  });

  test('rejects whitespace-only input', () => {
    assert.throws(
      () => parseRenderedTimeline('   \n\n  ', 'codex', 'thread-001'),
      /empty/i,
    );
  });

  test('accepts input without Thread section when Timeline is present', () => {
    const md = `---\nuri: agents://codex/thread-001\nprovider: codex\nthread: thread-001\n---\n\n## Timeline\n\n### 1. User\n\nHello\n\n### 2. Assistant\n\nHi\n`;
    const result = parseRenderedTimeline(md, 'codex', 'thread-001');
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]!.ordinalEnd, 2);
  });

  test('rejects input without Timeline section', () => {
    const md = `---\nuri: agents://codex/thread-001\nprovider: codex\nthread: thread-001\n---\n\n## Thread\n\nthread-001\n\n### 1. User\n\nHello\n\n### 2. Assistant\n\nHi\n`;
    assert.throws(
      () => parseRenderedTimeline(md, 'codex', 'thread-001'),
      /timeline/i,
    );
  });
});