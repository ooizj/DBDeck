/**
 * 把一段 SQL / 脚本按分号切分成多条语句，并记录每条在原文中的 [start, end) 偏移。
 *
 * 处理：字符串引号（' " `，含反斜杠转义）、行注释（--）、块注释（块注释），
 * 忽略纯空白语句。纯函数、无副作用，便于单独测试（从 app.js 抽出）。
 */
export function splitSqlStatementsWithOffsets(sql) {
    const statements = [];
    let start = 0;
    let hasToken = false;
    let quote = null;
    let lineComment = false;
    let blockComment = false;
    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i];
        const next = sql[i + 1];
        if (lineComment) {
            if (ch === '\n') lineComment = false;
            continue;
        }
        if (blockComment) {
            if (ch === '*' && next === '/') {
                blockComment = false;
                i++;
            }
            continue;
        }
        if (quote) {
            if (ch === '\\') {
                i++;
            } else if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (ch === '-' && next === '-') {
            lineComment = true;
            i++;
            continue;
        }
        if (ch === '/' && next === '*') {
            blockComment = true;
            i++;
            continue;
        }
        if (ch === '\'' || ch === '"' || ch === '`') {
            quote = ch;
            hasToken = true;
            continue;
        }
        if (ch === ';') {
            const text = sql.slice(start, i + 1).trim();
            if (text && hasToken) {
                statements.push({ text, start, end: i + 1 });
            }
            start = i + 1;
            hasToken = false;
            continue;
        }
        if (!/\s/.test(ch)) hasToken = true;
    }
    const tail = sql.slice(start).trim();
    if (tail && hasToken) {
        statements.push({ text: tail, start, end: sql.length });
    }
    return statements;
}

const MYSQL_ESCAPES = { '\\': '\\\\', "'": "\\'", '\0': '\\0', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\x1a': '\\Z' };
const PG_ESCAPES = { '\\': '\\\\', "'": "\\'", '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f]/;

/**
 * 把一个值格式化为指定方言的 SQL 字面量，保证生成的 INSERT 单行、可直接执行且不改变数据：
 * - MySQL：反斜杠是转义符，需转义 \ ' 以及换行等控制字符；
 * - PostgreSQL：普通字符串不识别反斜杠，含控制字符时改用 E'...' 转义字符串；
 * - SQLite：没有转义字符，控制字符用 char(n) 拼接。
 */
export function formatSqlLiteral(value, dialect) {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);

    if (dialect === 'mysql') {
        return "'" + text.replace(/[\\'\0\n\r\t\x1a]/g, ch => MYSQL_ESCAPES[ch]) + "'";
    }
    if (dialect === 'postgresql' && CONTROL_CHARS.test(text)) {
        // eslint-disable-next-line no-control-regex
        return "E'" + text.replace(/[\\'\x00-\x1f]/g, ch =>
            PG_ESCAPES[ch] || '\\x' + ch.charCodeAt(0).toString(16).padStart(2, '0')
        ) + "'";
    }
    if (dialect === 'sqlite' && CONTROL_CHARS.test(text)) {
        const parts = [];
        let buffer = '';
        for (const ch of text) {
            if (CONTROL_CHARS.test(ch)) {
                if (buffer) parts.push("'" + buffer.replace(/'/g, "''") + "'");
                parts.push(`char(${ch.charCodeAt(0)})`);
                buffer = '';
            } else {
                buffer += ch;
            }
        }
        if (buffer) parts.push("'" + buffer.replace(/'/g, "''") + "'");
        return parts.join(' || ');
    }
    return "'" + text.replace(/'/g, "''") + "'";
}
