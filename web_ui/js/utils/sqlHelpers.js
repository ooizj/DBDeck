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
