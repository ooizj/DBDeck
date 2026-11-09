import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    applySystemLocale,
    clearStoredLocale,
    hasStoredLocale,
    DEFAULT_LOCALE,
    STORAGE_KEY,
    currentLocale,
    detectLocale,
    getLocale,
    messages,
    normalizeLocale,
    setLocale,
    t,
} from '../../web_ui/js/i18n/index.js';
import { elementPlusLocale } from '../../web_ui/js/i18n/elementPlus.js';

const WEB_UI = fileURLToPath(new URL('../../web_ui/', import.meta.url));

const placeholders = text => [...String(text).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

function sourceFiles(dir = join(WEB_UI, 'js')) {
    const files = [];
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
            if (name !== 'i18n') files.push(...sourceFiles(path));
        } else if (name.endsWith('.js')) {
            files.push(path);
        }
    }
    return files;
}

const uiSources = () => [...sourceFiles(), join(WEB_UI, 'index.html')]
    .map(path => ({ path, text: readFileSync(path, 'utf8') }));

test('zh and en dictionaries define the same keys with the same placeholders', () => {
    const zhKeys = Object.keys(messages.zh).sort();
    const enKeys = Object.keys(messages.en).sort();
    assert.deepEqual(enKeys, zhKeys);
    for (const key of zhKeys) {
        assert.deepEqual(placeholders(messages.en[key]), placeholders(messages.zh[key]), `placeholders differ for ${key}`);
        assert.ok(messages.en[key].trim(), `empty English text for ${key}`);
        assert.ok(!/\p{Script=Han}/u.test(messages.en[key]), `Chinese text left in en.js for ${key}`);
    }
});

test('t() interpolates params, keeps unknown placeholders and falls back to the key', () => {
    setLocale('zh', { persist: false });
    assert.equal(t('source.databasesFound', { count: 3 }), '找到 3 个数据库');
    assert.equal(t('source.databasesFound'), '找到 {count} 个数据库');
    assert.equal(t('source.databasesFound', {}), '找到 {count} 个数据库');
    assert.equal(t('no.such.key'), 'no.such.key');
    // 非 key 的普通文本原样返回，供 reason 等既可能是 key 也可能是后端原文的字段使用
    assert.equal(t('表不存在'), '表不存在');

    setLocale('en', { persist: false });
    assert.equal(getLocale(), 'en');
    assert.equal(t('source.databasesFound', { count: 3 }), 'Found 3 database(s)');
    assert.equal(t('migrate.tableFailed', { table: 'users', error: 'boom' }), 'users: failed (boom)');
    setLocale(DEFAULT_LOCALE, { persist: false });
});

test('locale detection prefers the saved choice, then browser languages', () => {
    assert.equal(normalizeLocale('zh-TW'), 'zh');
    assert.equal(normalizeLocale('en-GB'), 'en');
    assert.equal(normalizeLocale('fr'), null);
    assert.equal(detectLocale({ stored: 'en', languages: ['zh-CN'] }), 'en');
    assert.equal(detectLocale({ stored: null, languages: ['fr-FR', 'zh-CN'] }), 'zh');
    assert.equal(detectLocale({ stored: null, languages: ['en-US'] }), 'en');
    assert.equal(detectLocale({ stored: null, languages: ['fr-FR', 'de'] }), 'en');
    // Node 环境没有 window：沿用应用原本的中文
    assert.equal(detectLocale({ stored: null }), DEFAULT_LOCALE);
});

test('setLocale persists valid choices and ignores unknown locales', () => {
    const store = new Map();
    globalThis.localStorage = {
        getItem: key => store.get(key) ?? null,
        setItem: (key, value) => store.set(key, String(value)),
    };
    try {
        assert.equal(setLocale('en-US'), 'en');
        assert.equal(store.get(STORAGE_KEY), 'en');
        assert.equal(currentLocale.value, 'en');
        assert.equal(setLocale('fr'), 'en');
        assert.equal(store.get(STORAGE_KEY), 'en');
        assert.equal(detectLocale({ languages: ['zh-CN'] }), 'en');
    } finally {
        delete globalThis.localStorage;
        setLocale(DEFAULT_LOCALE, { persist: false });
    }
});

test('system language is the default only until the user picks a language', () => {
    const store = new Map();
    globalThis.localStorage = {
        getItem: key => store.get(key) ?? null,
        setItem: (key, value) => store.set(key, String(value)),
        removeItem: key => store.delete(key),
    };
    try {
        setLocale('en', { persist: false });
        assert.equal(applySystemLocale('zh-Hans-CN'), 'zh');
        assert.equal(applySystemLocale('fr-FR'), 'en');
        assert.equal(applySystemLocale('zh_CN.UTF-8'), 'zh');
        assert.equal(applySystemLocale(null), 'zh');
        assert.equal(store.has(STORAGE_KEY), false, 'system default must not be saved as a user choice');

        setLocale('en');
        assert.equal(applySystemLocale('zh-Hans-CN'), 'en');

        // 设置里选「跟随系统」：清除保存的选择后重新按系统语言
        clearStoredLocale();
        assert.equal(hasStoredLocale(), false);
        assert.equal(applySystemLocale('zh-Hans-CN'), 'zh');
    } finally {
        delete globalThis.localStorage;
        setLocale(DEFAULT_LOCALE, { persist: false });
    }
});

test('Element Plus uses its built-in English for en and a Chinese pack for zh', () => {
    assert.equal(elementPlusLocale('en'), null);
    const zh = elementPlusLocale('zh');
    assert.equal(zh.name, 'zh-cn');
    assert.equal(zh.el.select.noData, '无数据');
    assert.equal(zh.el.messagebox.confirm, '确定');
});

test('every literal key passed to t()/$t() exists in the dictionaries', () => {
    const missing = [];
    const keyPattern = /\$?\bt\(\s*['"]([A-Za-z][\w-]*(?:\.[\w-]+)+)['"]/g;
    // 以 key 形式存放、渲染时再翻译的字段（reason / title / labelKey / messageKey）
    const storedKeyPattern = /\b(?:reason|title|labelKey|messageKey)\s*[:=]\s*'([a-z][\w-]*\.[\w.-]+)'/g;
    for (const { path, text } of uiSources()) {
        for (const pattern of [keyPattern, storedKeyPattern]) {
            for (const match of text.matchAll(pattern)) {
                if (!(match[1] in messages.zh)) missing.push(`${path}: ${match[1]}`);
            }
        }
    }
    assert.deepEqual(missing, []);
});

test('no hard-coded Chinese UI text is left outside the dictionaries', () => {
    // 这些是用户输入的解析规则，不是界面文案
    const allowed = [/\['1', 'true', 'yes', '是'\]/];
    const leftovers = [];
    for (const { path, text } of uiSources()) {
        const code = text
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .split('\n')
            .map(line => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'));
        code.forEach((line, index) => {
            if (!/\p{Script=Han}/u.test(line)) return;
            if (allowed.some(re => re.test(line))) return;
            leftovers.push(`${path}:${index + 1}: ${line.trim()}`);
        });
    }
    assert.deepEqual(leftovers, []);
});
