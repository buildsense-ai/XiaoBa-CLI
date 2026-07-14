import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ServiceManager } from '../src/dashboard/service-manager';

/**
 * Focused tests for the graceful-drain stop path in ServiceManager.
 *
 * The stop/stopAll paths must send SIGTERM first and let an active heartbeat
 * wake drain within the configured Review Deadline before force-killing,
 * instead of a hardcoded 5s / immediate SIGKILL. See ADR 0041.
 */

describe('dashboard service manager graceful drain (ADR 0041)', () => {
  test('stop() sends SIGTERM and waits the configured deadline before SIGKILL', async () => {
    const envKeys = [
      'XIAOBA_APP_ROOT',
      'XIAOBA_IS_PACKAGED',
      'XIAOBA_NODE_EXECUTABLE',
      'XIAOBA_RUNTIME_ROOT',
      'XIAOBA_SKILL_EVOLUTION_REVIEW_ATTEMPT_DEADLINE_MINUTES',
      'npm_node_execpath',
    ];
    const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));

    // Use a short configured deadline so the test does not hang.
    process.env.XIAOBA_SKILL_EVOLUTION_REVIEW_ATTEMPT_DEADLINE_MINUTES = '0.05'; // 3 seconds
    process.env.XIAOBA_APP_ROOT = process.cwd();
    process.env.XIAOBA_IS_PACKAGED = '0';
    delete process.env.XIAOBA_RUNTIME_ROOT;
    process.env.npm_node_execpath = process.execPath;

    try {
      const manager = new ServiceManager(process.cwd());
      const serviceRecord = (manager as any).services.get('weixin');
      // A process that ignores SIGTERM until the configured deadline forces SIGKILL.
      serviceRecord.info.command = process.execPath;
      serviceRecord.info.args = [
        '-e',
        // Trap SIGTERM and keep running so the force-kill timer must fire.
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
      ];

      const stopped = new Promise<void>(resolve => {
        manager.once('service-stopped', () => resolve());
      });

      manager.start('weixin');
      manager.stop('weixin');
      await stopped;

      const service = manager.getService('weixin');
      // A SIGKILL after the deadline produces a non-zero exit, but the
      // expectedExit flag makes status 'stopped' (not 'error').
      assert.equal(service?.status, 'stopped');
    } finally {
      for (const key of envKeys) {
        const value = previousEnv.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('stop() lets a graceful process exit on SIGTERM without force-kill', async () => {
    const envKeys = [
      'XIAOBA_APP_ROOT',
      'XIAOBA_IS_PACKAGED',
      'XIAOBA_NODE_EXECUTABLE',
      'XIAOBA_RUNTIME_ROOT',
      'XIAOBA_SKILL_EVOLUTION_REVIEW_ATTEMPT_DEADLINE_MINUTES',
      'npm_node_execpath',
    ];
    const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));

    process.env.XIAOBA_SKILL_EVOLUTION_REVIEW_ATTEMPT_DEADLINE_MINUTES = '10';
    process.env.XIAOBA_APP_ROOT = process.cwd();
    process.env.XIAOBA_IS_PACKAGED = '0';
    delete process.env.XIAOBA_RUNTIME_ROOT;
    process.env.npm_node_execpath = process.execPath;

    try {
      const manager = new ServiceManager(process.cwd());
      const serviceRecord = (manager as any).services.get('feishu');
      // A process that exits cleanly on SIGTERM (simulates graceful drain).
      serviceRecord.info.command = process.execPath;
      serviceRecord.info.args = [
        '-e',
        "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);",
      ];

      const stopped = new Promise<void>(resolve => {
        manager.once('service-stopped', () => resolve());
      });

      manager.start('feishu');
      manager.stop('feishu');
      await stopped;

      const service = manager.getService('feishu');
      assert.equal(service?.status, 'stopped');
      assert.equal(service?.lastError, undefined);
    } finally {
      for (const key of envKeys) {
        const value = previousEnv.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('stopAll() sends SIGTERM before force-kill on non-Windows', async () => {
    if (process.platform === 'win32') {
      // Windows uses taskkill /F exclusively; skip the SIGTERM drain test.
      return;
    }

    const envKeys = [
      'XIAOBA_APP_ROOT',
      'XIAOBA_IS_PACKAGED',
      'XIAOBA_NODE_EXECUTABLE',
      'XIAOBA_RUNTIME_ROOT',
      'XIAOBA_SKILL_EVOLUTION_REVIEW_ATTEMPT_DEADLINE_MINUTES',
      'npm_node_execpath',
    ];
    const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));

    process.env.XIAOBA_SKILL_EVOLUTION_REVIEW_ATTEMPT_DEADLINE_MINUTES = '0.05'; // 3 seconds
    process.env.XIAOBA_APP_ROOT = process.cwd();
    process.env.XIAOBA_IS_PACKAGED = '0';
    delete process.env.XIAOBA_RUNTIME_ROOT;
    process.env.npm_node_execpath = process.execPath;

    try {
      const manager = new ServiceManager(process.cwd());
      const serviceRecord = (manager as any).services.get('catscompany');
      serviceRecord.info.command = process.execPath;
      serviceRecord.info.args = [
        '-e',
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
      ];

      const stopped = new Promise<void>(resolve => {
        manager.once('service-stopped', () => resolve());
      });

      manager.start('catscompany');
      manager.stopAll();
      await stopped;

      const service = manager.getService('catscompany');
      assert.equal(service?.status, 'stopped');
    } finally {
      for (const key of envKeys) {
        const value = previousEnv.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('drainAll() resolves after a graceful child exit', async () => {
    const previous = process.env.XIAOBA_SKILL_EVOLUTION_REVIEW_ATTEMPT_DEADLINE_MINUTES;
    process.env.XIAOBA_SKILL_EVOLUTION_REVIEW_ATTEMPT_DEADLINE_MINUTES = '0.05';
    try {
      const manager = new ServiceManager(process.cwd());
      const serviceRecord = (manager as any).services.get('catscompany');
      serviceRecord.info.command = process.execPath;
      serviceRecord.info.args = [
        '-e',
        "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);",
      ];

      manager.start('catscompany');
      await manager.drainAll();

      assert.equal(manager.getService('catscompany')?.status, 'stopped');
    } finally {
      if (previous === undefined) delete process.env.XIAOBA_SKILL_EVOLUTION_REVIEW_ATTEMPT_DEADLINE_MINUTES;
      else process.env.XIAOBA_SKILL_EVOLUTION_REVIEW_ATTEMPT_DEADLINE_MINUTES = previous;
    }
  });

  test('drainAll() does not hang when a child emits an error before exit', async () => {
    const previous = process.env.XIAOBA_SKILL_EVOLUTION_REVIEW_ATTEMPT_DEADLINE_MINUTES;
    process.env.XIAOBA_SKILL_EVOLUTION_REVIEW_ATTEMPT_DEADLINE_MINUTES = '0.05';
    try {
      const manager = new ServiceManager(process.cwd());
      const serviceRecord = (manager as any).services.get('weixin');
      serviceRecord.info.command = path.join(os.tmpdir(), `xiaoba-missing-${process.pid}`);
      serviceRecord.info.args = [];

      manager.start('weixin');
      await Promise.race([
        manager.drainAll(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('drainAll timed out')), 2_000)),
      ]);
    } finally {
      if (previous === undefined) delete process.env.XIAOBA_SKILL_EVOLUTION_REVIEW_ATTEMPT_DEADLINE_MINUTES;
      else process.env.XIAOBA_SKILL_EVOLUTION_REVIEW_ATTEMPT_DEADLINE_MINUTES = previous;
    }
  });
});
