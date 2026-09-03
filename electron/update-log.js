'use strict';

const fs = require('fs');
const path = require('path');
const util = require('util');

const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_LOG_ENTRY_LENGTH = 4000;

function sanitizeUpdateLogMessage(value) {
  return String(value || '')
    .replace(/([?&][^=\s&]+)=([^&\s]+)/g, '$1=[REDACTED]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/\b((?:token|access[_-]?token|api[_-]?key|authorization)\s*[:=]\s*)["']?[^\s,"'}]+/gi, '$1[REDACTED]')
    .slice(0, MAX_LOG_ENTRY_LENGTH);
}

function createUpdateLogger({ logPath, maxBytes = DEFAULT_MAX_BYTES, consoleImpl = console }) {
  const resolvedLogPath = path.resolve(logPath);
  const previousLogPath = `${resolvedLogPath}.previous`;

  function rotateIfNeeded() {
    try {
      if (!fs.existsSync(resolvedLogPath) || fs.statSync(resolvedLogPath).size < maxBytes) return;
      if (fs.existsSync(previousLogPath)) fs.unlinkSync(previousLogPath);
      fs.renameSync(resolvedLogPath, previousLogPath);
    } catch (error) {
      consoleImpl.warn?.('[auto-update] Failed to rotate updater log:', error);
    }
  }

  function write(level, values) {
    const message = sanitizeUpdateLogMessage(util.format(...values));
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}\n`;
    try {
      fs.mkdirSync(path.dirname(resolvedLogPath), { recursive: true });
      rotateIfNeeded();
      fs.appendFileSync(resolvedLogPath, line, 'utf8');
    } catch (error) {
      consoleImpl.warn?.('[auto-update] Failed to write updater log:', error);
    }

    const consoleMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
    consoleImpl[consoleMethod]?.(`[auto-update] ${message}`);
  }

  return {
    logPath: resolvedLogPath,
    debug: (...values) => write('debug', values),
    info: (...values) => write('info', values),
    warn: (...values) => write('warn', values),
    error: (...values) => write('error', values),
  };
}

module.exports = {
  DEFAULT_MAX_BYTES,
  MAX_LOG_ENTRY_LENGTH,
  createUpdateLogger,
  sanitizeUpdateLogMessage,
};
