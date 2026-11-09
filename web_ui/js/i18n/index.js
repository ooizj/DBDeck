// Lightweight UI i18n: flat message dictionaries + a reactive current locale.
//
// - t(key, params) looks the key up in the current locale, falls back to Chinese, then to the key itself,
//   and fills {name} placeholders from params.
// - The current locale is a Vue ref when Vue is loaded, so templates that call $t()/t() re-render on switch.
//   In Node tests (no Vue global) it is a plain { value } holder.
// - The choice is kept in localStorage and also mirrored to the backend (see app.js), because the desktop
//   WebView may not persist localStorage between launches.
import zh from './zh.js';
import en from './en.js';

export const LOCALES = [
    { id: 'zh', label: '中文', htmlLang: 'zh-CN' },
    { id: 'en', label: 'English', htmlLang: 'en' },
];
export const DEFAULT_LOCALE = 'zh';
export const STORAGE_KEY = 'dbdeck.locale';

const MESSAGES = { zh, en };

export function normalizeLocale(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text) return null;
    if (text.startsWith('zh')) return 'zh';
    if (text.startsWith('en')) return 'en';
    return null;
}

function readStoredLocale() {
    try {
        return normalizeLocale(globalThis.localStorage?.getItem(STORAGE_KEY));
    } catch (_) {
        return null;
    }
}

/**
 * Initial locale: saved choice → browser/system languages → English for any other language.
 * Without a browser (Node tests) the default is Chinese, the app's original language.
 */
export function detectLocale({ stored = readStoredLocale(), languages } = {}) {
    if (stored) return stored;
    const browserLanguages = languages ?? (
        typeof window !== 'undefined' && window.navigator
            ? (window.navigator.languages?.length ? window.navigator.languages : [window.navigator.language])
            : null
    );
    if (!browserLanguages) return DEFAULT_LOCALE;
    for (const lang of browserLanguages) {
        const locale = normalizeLocale(lang);
        if (locale) return locale;
    }
    return 'en';
}

const makeRef = globalThis.Vue?.ref || (value => ({ value }));
export const currentLocale = makeRef(detectLocale());

/** 用户是否手动选过语言（选过就不再跟随系统语言）。 */
export function hasStoredLocale() {
    return Boolean(readStoredLocale());
}

/** 清除用户保存的语言选择（恢复「跟随系统」）。 */
export function clearStoredLocale() {
    try { globalThis.localStorage?.removeItem(STORAGE_KEY); } catch (_) { /* storage unavailable */ }
}

/**
 * 没有手动选择时，按操作系统语言（后端检测）决定语言；中文系统 → 中文，其他 → English。
 * 拿不到系统语言时退回浏览器语言。
 */
export function applySystemLocale(systemLanguage) {
    if (hasStoredLocale()) return currentLocale.value;
    const languages = systemLanguage ? [systemLanguage] : undefined;
    return setLocale(detectLocale({ stored: null, languages }), { persist: false });
}

export function getLocale() {
    return currentLocale.value;
}

function applyDocumentLang(locale) {
    if (typeof document === 'undefined' || !document.documentElement) return;
    document.documentElement.lang = LOCALES.find(item => item.id === locale)?.htmlLang || locale;
}

/** Switch locale; returns the locale actually applied (unknown values are ignored). */
export function setLocale(value, { persist = true } = {}) {
    const locale = normalizeLocale(value);
    if (!locale) return currentLocale.value;
    currentLocale.value = locale;
    if (persist) {
        try { globalThis.localStorage?.setItem(STORAGE_KEY, locale); } catch (_) { /* storage unavailable */ }
    }
    applyDocumentLang(locale);
    return locale;
}

export function hasMessage(key, locale = currentLocale.value) {
    return Object.prototype.hasOwnProperty.call(MESSAGES[locale] || {}, key);
}

export function t(key, params) {
    const locale = currentLocale.value;
    let text = MESSAGES[locale]?.[key];
    if (text === undefined) text = MESSAGES[DEFAULT_LOCALE][key];
    if (text === undefined) return key;
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (match, name) => (
        Object.prototype.hasOwnProperty.call(params, name) && params[name] !== undefined && params[name] !== null
            ? String(params[name])
            : match
    ));
}

export const messages = MESSAGES;

applyDocumentLang(currentLocale.value);
