export function redactReviewText(value: unknown, maxLength?: number): string {
  const text = String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/catslog_(?:tok|review)_[A-Za-z0-9._~+/=-]+/gi, 'catslog_[REDACTED]')
    .replace(/sk-[A-Za-z0-9]{12,}/g, 'sk-[REDACTED]')
    .replace(/\bcatsco_\d+\b/gi, '[USER_ID_REDACTED]')
    .replace(/(["']?(?:user_id|device_id|device_name|session_id)["']?\s*[:=]\s*)(["'])?[^"',}\]\r\n]+(["'])?/gi, '$1[RAW_ID_REDACTED]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL_REDACTED]')
    .replace(/\b1[3-9]\d{9}\b/g, '[PHONE_REDACTED]')
    .replace(/\b\d{17}[\dXx]\b/g, '[ID_REDACTED]')
    .replace(/(学号|工号|身份证号?|证件号?)\s*[:：]?\s*[A-Za-z0-9-]{6,24}/g, '$1 [ID_REDACTED]')
    .replace(/(学生姓名|教师姓名|老师姓名|姓名)\s*[:：]?\s*[\u4e00-\u9fa5·]{2,8}/g, '$1 [NAME_REDACTED]')
    .replace(/[\u4e00-\u9fa5·]{2,4}同学/g, '[STUDENT_REDACTED]')
    .replace(/((?:高|初)?[一二三四五六七八九十0-9]{1,2}年级[\u4e00-\u9fa5A-Za-z0-9-]{0,10}班)/g, '[CLASS_REDACTED]')
    .replace(/(微信号?|QQ|qq)\s*[:：]?\s*[A-Za-z0-9_-]{5,32}/g, '$1 [CONTACT_REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL_REDACTED]')
    .replace(/[A-Za-z]:[\\/](?:[^\\/\r\n"'<>|]+[\\/])*[^\\/\r\n"'<>|]*/g, '[PATH_REDACTED]')
    .replace(/\\\\[^\\/\r\n"'<>|]+[\\/](?:[^\\/\r\n"'<>|]+[\\/])*[^\\/\r\n"'<>|]*/g, '[PATH_REDACTED]')
    .replace(/\/(?:Users|home)\/[^/\s]+(?:\/[^\r\n"'<>|]*)?/g, '/[USER_PATH_REDACTED]')
    .replace(/\/(?:tmp|var|opt|data)\/[^\r\n"'<>|]*/g, '/[PATH_REDACTED]');

  return typeof maxLength === 'number' ? text.slice(0, maxLength) : text;
}
