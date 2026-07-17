/**
 * Issue #94 — release-gate fixture validation.
 *
 * Validates adversarial rendered-Timeline fixtures and synthetic provider roots.
 * These tests exercise the standalone public seams added for #94 and remain
 * useful before and after #90–#93 integrate.
 */
import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseRenderedTimeline } from '../src/utils/xurl-rendered-timeline';

const FIXTURE_ROOT = path.join(process.cwd(), 'tests', 'fixtures');
const TIMELINE_ROOT = path.join(FIXTURE_ROOT, 'xurl-timeline');
const SMOKE_ROOT = path.join(FIXTURE_ROOT, 'xurl-smoke');

function readFixture(...parts: string[]): string {
  return fs.readFileSync(path.join(...parts), 'utf8');
}

describe('xurl release-gate fixtures — rendered Timeline', () => {
  test('valid-minimal fixture parses', () => {
    const markdown = readFixture(TIMELINE_ROOT, 'valid-minimal.md');
    const result = parseRenderedTimeline(markdown, 'codex', 'thread-001');
    assert.equal(result.events.length, 1);
  });

  test('valid multi-turn fixture parses', () => {
    const markdown = readFixture(TIMELINE_ROOT, 'valid-multi-turn-with-context.md');
    const result = parseRenderedTimeline(markdown, 'codex', 'thread-002');
    assert.equal(result.events.length, 2);
    assert.equal(result.branch, 'feature-branch');
  });

  test('frontmatter spoof fixture fails closed', () => {
    const markdown = readFixture(TIMELINE_ROOT, 'adversarial-frontmatter-spoof.md');
    assert.throws(() => parseRenderedTimeline(markdown, 'codex', 'thread-001'), /provider.*mismatch/i);
  });

  test('frontmatter line without colon fixture fails closed', () => {
    const markdown = readFixture(TIMELINE_ROOT, 'adversarial-frontmatter-no-colon.md');
    assert.throws(() => parseRenderedTimeline(markdown, 'codex', 'thread-001'), /frontmatter|invalid line|colon/i);
  });

  test('frontmatter duplicate key fixture fails closed', () => {
    const markdown = readFixture(TIMELINE_ROOT, 'adversarial-frontmatter-duplicate-key.md');
    assert.throws(() => parseRenderedTimeline(markdown, 'codex', 'thread-001'), /frontmatter|duplicate/i);
  });

  test('duplicate ordinal fixture fails closed', () => {
    const markdown = readFixture(TIMELINE_ROOT, 'adversarial-duplicate-ordinal.md');
    assert.throws(() => parseRenderedTimeline(markdown, 'codex', 'thread-001'), /duplicate/i);
  });

  test('non-monotonic ordinal fixture fails closed', () => {
    const markdown = readFixture(TIMELINE_ROOT, 'adversarial-non-monotonic-ordinal.md');
    assert.throws(() => parseRenderedTimeline(markdown, 'codex', 'thread-001'), /non.monotonic|ordinal/i);
  });

  test('malformed role fixture fails closed', () => {
    const markdown = readFixture(TIMELINE_ROOT, 'adversarial-malformed-role.md');
    assert.throws(
      () => parseRenderedTimeline(markdown, 'codex', 'thread-001'),
      /unsupported role|forbidden prompt-control role/i,
    );
  });

  test('heading-shaped content fixture documents residual ambiguity via failure', () => {
    const markdown = readFixture(TIMELINE_ROOT, 'adversarial-heading-shaped-content.md');
    assert.throws(() => parseRenderedTimeline(markdown, 'codex', 'thread-001'));
  });

  test('incomplete tail fixture fails closed', () => {
    const markdown = readFixture(TIMELINE_ROOT, 'adversarial-incomplete-tail.md');
    assert.throws(() => parseRenderedTimeline(markdown, 'codex', 'thread-001'), /incomplete/i);
  });
});

describe('xurl release-gate fixtures — synthetic provider roots', () => {
  test('codex smoke fixture is present and parseable', () => {
    const markdown = readFixture(SMOKE_ROOT, 'codex', 'threads', 'codex-thread-001.md');
    const result = parseRenderedTimeline(markdown, 'codex', 'codex-thread-001');
    assert.equal(result.events.length, 1);
  });

  test('claude smoke fixture is present and parseable', () => {
    const markdown = readFixture(SMOKE_ROOT, 'claude', 'threads', 'claude-thread-001.md');
    const result = parseRenderedTimeline(markdown, 'claude', 'claude-thread-001');
    assert.equal(result.events.length, 1);
  });

  test('pi smoke fixture is present and parseable', () => {
    const markdown = readFixture(SMOKE_ROOT, 'pi', 'threads', 'pi-thread-001.md');
    const result = parseRenderedTimeline(markdown, 'pi', 'pi-thread-001');
    assert.equal(result.events.length, 1);
  });
});