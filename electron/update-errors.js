'use strict';

const MAX_PUBLIC_UPDATE_ERROR_LENGTH = 800;
const MISSING_MACOS_ZIP_MESSAGE = 'macOS 自动更新包缺少 ZIP 文件，请手动下载安装包，或等待维护者重新发布。';

function limitMessage(message) {
  if (message.length <= MAX_PUBLIC_UPDATE_ERROR_LENGTH) return message;
  return `${message.slice(0, MAX_PUBLIC_UPDATE_ERROR_LENGTH)}...`;
}

function normalizeUpdateError(error, fallbackReason = 'UPDATE_ERROR') {
  const rawMessage = String(error?.message || error || 'Unknown update error').trim();
  const errorCode = String(error?.code || '').trim();

  if (errorCode === 'ERR_UPDATER_ZIP_FILE_NOT_FOUND' || /ZIP file not provided/i.test(rawMessage)) {
    return {
      reason: 'MACOS_UPDATE_ZIP_MISSING',
      message: MISSING_MACOS_ZIP_MESSAGE,
    };
  }

  let reason = fallbackReason;
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(rawMessage)) {
    reason = 'DNS_LOOKUP_FAILED';
  } else if (/ETIMEDOUT|timeout/i.test(rawMessage)) {
    reason = 'NETWORK_TIMEOUT';
  } else if (/ECONNREFUSED|ECONNRESET|socket hang up/i.test(rawMessage)) {
    reason = 'NETWORK_CONNECTION_FAILED';
  } else if (/401|403|unauthorized|forbidden/i.test(rawMessage)) {
    reason = 'ACCESS_DENIED';
  } else if (/404|not\s*found/i.test(rawMessage)) {
    reason = 'RELEASE_NOT_FOUND';
  } else if (/sha|checksum|signature|integrity/i.test(rawMessage)) {
    reason = 'PACKAGE_VALIDATION_FAILED';
  }

  return { reason, message: limitMessage(rawMessage) };
}

module.exports = {
  MAX_PUBLIC_UPDATE_ERROR_LENGTH,
  MISSING_MACOS_ZIP_MESSAGE,
  normalizeUpdateError,
};
