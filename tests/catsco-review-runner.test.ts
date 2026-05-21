import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { fetchReviewData, runCatscoReviewAgent } from '../src/utils/catsco-review-runner';
import type { CatscoReviewAgentConfig } from '../src/utils/catsco-review-agent-config';

describe('catsco review runner', () => {
  test('refuses to run when disabled', async () => {
    const config: CatscoReviewAgentConfig = {
      enabled: false,
      apiBaseUrl: 'https://logs.example.test:8000',
      reviewToken: 'review-token',
      outputDir: 'unused',
      lookbackHours: 24,
      intervalMinutes: 360,
      maxFailures: 10,
      maxSessions: 10,
      maxEntriesPerSession: 10,
      maxTurnsPerSession: 10,
      prBaseBranch: 'main',
      gitRemote: 'origin',
      createBranch: false,
      commitChanges: false,
      createGithubPr: false,
    };

    await assert.rejects(
      () => runCatscoReviewAgent(config),
      /CATSCO_REVIEW_ENABLED=true/,
    );
  });

  test('records per-session detail fetch failures without failing the whole run', async () => {
    const data = await fetchReviewData({
      summary: async () => ({
        upload_count: 1,
        parsed_upload_count: 1,
        failed_upload_count: 0,
        session_count: 1,
        turn_count: 0,
        ai_call_count: 0,
        tool_call_count: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      }),
      failures: async () => ({ page: { limit: 10, offset: 0, count: 0 }, failures: [] }),
      sessions: async () => ({
        page: { limit: 10, offset: 0, count: 1 },
        sessions: [{
          session_record_id: 'session-1',
          upload_id: 'upload-1',
          user_key: 'user',
          device_key: 'device',
          session_key: 'session',
          session_type: 'cli',
          entry_count: 1,
          runtime_count: 1,
          turn_count: 0,
          ai_call_count: 0,
          tool_call_count: 0,
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          summary_status: 'ready',
          created_at: '2026-05-20 00:00:00',
        }],
      }),
      entries: async () => {
        throw new Error('detail unavailable');
      },
      turns: async () => ({ page: { limit: 10, offset: 0, count: 0 }, turns: [] }),
    } as any, {
      uploadedFrom: '2026-05-20T00:00:00Z',
      maxFailures: 10,
      maxSessions: 10,
      maxEntriesPerSession: 10,
      maxTurnsPerSession: 10,
    });

    assert.equal(data.sessions.length, 1);
    assert.equal(data.sessionEntries['session-1'][0].entry_type, 'review_fetch_error');
    assert.match(data.sessionEntries['session-1'][0].message || '', /detail unavailable/);
    assert.deepEqual(data.sessionTurns['session-1'], []);
  });

  test('fetches paged failures and sessions up to configured limits', async () => {
    const failureOffsets: number[] = [];
    const sessionOffsets: number[] = [];
    const uploadedToValues: Array<string | undefined> = [];
    const data = await fetchReviewData({
      summary: async (_uploadedFrom: string, uploadedTo?: string) => {
        uploadedToValues.push(uploadedTo);
        return ({
        upload_count: 3,
        parsed_upload_count: 3,
        failed_upload_count: 0,
        session_count: 2,
        turn_count: 0,
        ai_call_count: 0,
        tool_call_count: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        });
      },
      failures: async (limit: number, _uploadedFrom: string, offset: number, uploadedTo?: string) => {
        uploadedToValues.push(uploadedTo);
        failureOffsets.push(offset);
        const failures = [
          { failure_type: 'log_entry', upload_id: 'u1', event_category: 'runtime', message: 'error one' },
          { failure_type: 'log_entry', upload_id: 'u2', event_category: 'runtime', message: 'error two' },
          { failure_type: 'log_entry', upload_id: 'u3', event_category: 'runtime', message: 'error three' },
        ].slice(offset, offset + limit);
        return {
          page: { limit, offset, count: failures.length, has_more: offset + failures.length < 3, next_offset: offset + failures.length },
          failures,
        };
      },
      sessions: async (limit: number, _uploadedFrom: string, offset: number, uploadedTo?: string) => {
        uploadedToValues.push(uploadedTo);
        sessionOffsets.push(offset);
        const sessions = [
          {
            session_record_id: 'session-1',
            upload_id: 'upload-1',
            user_key: 'user',
            device_key: 'device',
            session_key: 'session-1',
            session_type: 'cli',
            entry_count: 0,
            runtime_count: 0,
            turn_count: 0,
            ai_call_count: 0,
            tool_call_count: 0,
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            summary_status: 'ready',
            created_at: '2026-05-20 00:00:00',
          },
          {
            session_record_id: 'session-2',
            upload_id: 'upload-2',
            user_key: 'user',
            device_key: 'device',
            session_key: 'session-2',
            session_type: 'cli',
            entry_count: 0,
            runtime_count: 0,
            turn_count: 0,
            ai_call_count: 0,
            tool_call_count: 0,
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            summary_status: 'ready',
            created_at: '2026-05-20 00:00:00',
          },
        ].slice(offset, offset + limit);
        return {
          page: { limit, offset, count: sessions.length, has_more: offset + sessions.length < 2, next_offset: offset + sessions.length },
          sessions,
        };
      },
      entries: async () => ({ page: { limit: 10, offset: 0, count: 0 }, entries: [] }),
      turns: async () => ({ page: { limit: 10, offset: 0, count: 0 }, turns: [] }),
    } as any, {
      uploadedFrom: '2026-05-20T00:00:00Z',
      uploadedTo: '2026-05-20T01:00:00Z',
      maxFailures: 3,
      maxSessions: 2,
      maxEntriesPerSession: 10,
      maxTurnsPerSession: 10,
    });

    assert.equal(data.failures.length, 3);
    assert.equal(data.sessions.length, 2);
    assert.deepEqual(failureOffsets, [0]);
    assert.deepEqual(sessionOffsets, [0]);
    assert.deepEqual(uploadedToValues, [
      '2026-05-20T01:00:00Z',
      '2026-05-20T01:00:00Z',
      '2026-05-20T01:00:00Z',
    ]);
  });

  test('does not infer another page when API explicitly says has_more is false', async () => {
    const failureOffsets: number[] = [];
    const data = await fetchReviewData({
      summary: async () => ({
        upload_count: 200,
        parsed_upload_count: 200,
        failed_upload_count: 0,
        session_count: 0,
        turn_count: 0,
        ai_call_count: 0,
        tool_call_count: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      }),
      failures: async (limit: number, _uploadedFrom: string, offset: number) => {
        failureOffsets.push(offset);
        const failures = Array.from({ length: limit }, (_, index) => ({
          failure_type: 'log_entry',
          upload_id: `upload-${index}`,
          event_category: 'runtime',
          message: `error ${index}`,
        }));
        return {
          page: { limit, offset, count: failures.length, has_more: false, next_offset: offset + failures.length },
          failures,
        };
      },
      sessions: async () => ({ page: { limit: 10, offset: 0, count: 0, has_more: false }, sessions: [] }),
      entries: async () => ({ page: { limit: 10, offset: 0, count: 0 }, entries: [] }),
      turns: async () => ({ page: { limit: 10, offset: 0, count: 0 }, turns: [] }),
    } as any, {
      uploadedFrom: '2026-05-20T00:00:00Z',
      maxFailures: 250,
      maxSessions: 10,
      maxEntriesPerSession: 10,
      maxTurnsPerSession: 10,
    });

    assert.equal(data.failures.length, 200);
    assert.deepEqual(failureOffsets, [0]);
  });

  test('passes target user/device filters to sessions and filters failures to matched sessions', async () => {
    let capturedFilters: any;
    const data = await fetchReviewData({
      summary: async () => ({
        upload_count: 10,
        parsed_upload_count: 10,
        failed_upload_count: 0,
        session_count: 10,
        turn_count: 0,
        ai_call_count: 0,
        tool_call_count: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      }),
      failures: async () => ({
        page: { limit: 10, offset: 0, count: 2, has_more: false },
        failures: [
          { failure_type: 'log_entry', upload_id: 'u1', session_record_id: 'session-1', event_category: 'runtime', message: 'error one' },
          { failure_type: 'log_entry', upload_id: 'u2', session_record_id: 'session-2', event_category: 'runtime', message: 'error two' },
        ],
      }),
      sessions: async (_limit: number, _uploadedFrom: string, _offset: number, _uploadedTo?: string, filters?: any) => {
        capturedFilters = filters;
        return {
          page: { limit: 10, offset: 0, count: 1, has_more: false },
          sessions: [{
            session_record_id: 'session-1',
            upload_id: 'u1',
            user_key: 'teacher-key',
            device_key: 'device-key',
            session_key: 'session-key',
            session_type: 'chat',
            entry_count: 0,
            runtime_count: 0,
            turn_count: 0,
            ai_call_count: 0,
            tool_call_count: 0,
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            summary_status: 'ready',
            created_at: '2026-05-20 00:00:00',
          }],
        };
      },
      entries: async () => ({ page: { limit: 10, offset: 0, count: 0 }, entries: [] }),
      turns: async () => ({ page: { limit: 10, offset: 0, count: 0 }, turns: [] }),
    } as any, {
      uploadedFrom: '2026-05-20T00:00:00Z',
      maxFailures: 10,
      maxSessions: 10,
      maxEntriesPerSession: 10,
      maxTurnsPerSession: 10,
      targetUserKey: 'teacher-key',
      targetDeviceKey: 'device-key',
    });

    assert.deepEqual(capturedFilters, { userKey: 'teacher-key', deviceKey: 'device-key' });
    assert.equal(data.failures.length, 1);
    assert.equal(data.failures[0].session_record_id, 'session-1');
    assert.equal(data.summary.session_count, 1);
  });
});
