import zhCN from './zh-CN.json';

const locales = { 'zh-CN': zhCN };
let currentLocale = 'zh-CN';

export function setLocale(locale) {
  if (locales[locale]) {
    currentLocale = locale;
  }
}

export function t(key, params = {}) {
  const strings = locales[currentLocale] || locales['zh-CN'];
  let text = strings[key] || key;
  Object.entries(params).forEach(([k, v]) => {
    text = text.replace(`{${k}}`, v);
  });
  return text;
}

export default t;
