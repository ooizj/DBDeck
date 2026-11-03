const RELATION_KEYWORDS = new Set([
    'WHERE', 'ON', 'USING', 'LIMIT', 'OFFSET', 'GROUP', 'ORDER', 'JOIN', 'LEFT', 'RIGHT',
    'INNER', 'OUTER', 'FULL', 'CROSS', 'NATURAL', 'STRAIGHT_JOIN', 'HAVING', 'UNION',
    'INTERSECT', 'EXCEPT', 'RETURNING', 'SET', 'VALUES', 'VALUE', 'SELECT', 'WINDOW',
    'FOR', 'LOCK', 'USE', 'FORCE', 'IGNORE', 'PARTITION', 'DEFAULT',
]);

// 出现在 FROM 表列表之后、表示表列表已结束的关键字
const RELATION_LIST_TERMINATORS = /\b(?:WHERE|ON|USING|JOIN|GROUP|ORDER|HAVING|LIMIT|OFFSET|UNION|INTERSECT|EXCEPT|SET|VALUES|SELECT|WINDOW|RETURNING|FOR)\b/i;

const SELECT_CONTEXT_KEYWORDS = [
    'DISTINCT', 'FROM', 'AS', 'WHERE', 'AND', 'OR', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN',
    'INNER JOIN', 'FULL JOIN', 'ON', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT',
    'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT',
];

const CONDITION_KEYWORDS = ['AND', 'OR', 'NOT', 'IN', 'LIKE', 'ILIKE', 'BETWEEN', 'IS NULL', 'IS NOT NULL'];

const WHITESPACE_COMPLETION_KEYWORDS = new Set([
    'SELECT', 'DISTINCT', 'WHERE', 'HAVING', 'ON', 'AND', 'OR', 'BY', 'NOT',
    'WHEN', 'THEN', 'ELSE', 'SET', 'VALUES', 'IN', 'LIKE', 'ILIKE', 'CASE',
]);

const COLUMN_STATEMENT_KINDS = new Set(['SELECT', 'WITH', 'UPDATE', 'DELETE', 'INSERT', 'REPLACE']);

const IDENT = '[A-Za-z0-9_$\\u00C0-\\uFFFF]';
const IDENT_REGEX = new RegExp(`${IDENT}+`, 'y');

/**
 * 扫描 SQL，返回把注释和单引号字符串内容替换为空格后的文本（长度不变），
 * 以及扫描到末尾时所处的状态。反引号 / 双引号视为标识符，保留原文。
 */
const scanSql = (text) => {
    let masked = '';
    let quote = '';
    let quoteStart = -1;
    let lineComment = false;
    let blockComment = false;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1] || '';

        if (lineComment) {
            if (char === '\n') {
                lineComment = false;
                masked += char;
            } else {
                masked += ' ';
            }
            continue;
        }
        if (blockComment) {
            if (char === '*' && next === '/') {
                blockComment = false;
                masked += '  ';
                index += 1;
            } else {
                masked += char === '\n' ? '\n' : ' ';
            }
            continue;
        }
        if (quote) {
            const keep = quote !== "'";
            if (char === '\\' && quote === "'") {
                masked += next ? '  ' : ' ';
                index += 1;
                continue;
            }
            if (char === quote) {
                if (next === quote) {
                    masked += keep ? char + next : '  ';
                    index += 1;
                } else {
                    masked += char;
                    quote = '';
                }
                continue;
            }
            masked += keep || char === '\n' ? char : ' ';
            continue;
        }
        if (char === '-' && next === '-') {
            lineComment = true;
            masked += '  ';
            index += 1;
            continue;
        }
        if (char === '/' && next === '*') {
            blockComment = true;
            masked += '  ';
            index += 1;
            continue;
        }
        if (char === "'" || char === '"' || char === '`') {
            quote = char;
            quoteStart = index;
        }
        masked += char;
    }

    return { masked, quote, quoteStart, inComment: lineComment || blockComment };
};

const shouldSuggestAfterWhitespace = (textBeforeCursor) => {
    if (!/\s$/.test(textBeforeCursor)) return true;

    const trimmed = textBeforeCursor.trimEnd();
    if (!trimmed) return false;
    if (/[,(]$/.test(trimmed)) return true;
    if (/(?:=|<>|!=|<=|>=|<|>|[-+/%])$/.test(trimmed)) return true;

    const previousWord = trimmed.match(/[A-Za-z]+$/)?.[0]?.toUpperCase();
    return Boolean(previousWord && WHITESPACE_COMPLETION_KEYWORDS.has(previousWord));
};

const CLAUSE_REGEX = /\b(GROUP\s+BY|ORDER\s+BY|HAVING|WHERE|ON|JOIN|FROM|SELECT|SET|VALUES|LIMIT)\b/gi;

const activeClauseAt = (maskedBeforeCursor) => {
    let active = '';
    let match;
    CLAUSE_REGEX.lastIndex = 0;
    while ((match = CLAUSE_REGEX.exec(maskedBeforeCursor)) !== null) {
        active = match[1].toUpperCase().replace(/\s+/g, ' ');
    }
    return active;
};

const selectKeywordsAtCursor = (activeClause) => {
    if (!activeClause || activeClause === 'SELECT') return ['DISTINCT', 'FROM', 'AS'];
    if (activeClause === 'WHERE' || activeClause === 'HAVING') {
        return [...CONDITION_KEYWORDS, 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET'];
    }
    if (activeClause === 'ON') {
        return [...CONDITION_KEYWORDS, 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'WHERE', 'GROUP BY', 'ORDER BY', 'LIMIT'];
    }
    if (activeClause === 'GROUP BY') return ['HAVING', 'ORDER BY', 'LIMIT', 'OFFSET'];
    if (activeClause === 'ORDER BY') return ['ASC', 'DESC', 'LIMIT', 'OFFSET'];
    if (activeClause === 'LIMIT') return ['OFFSET'];
    if (activeClause === 'FROM' || activeClause === 'JOIN') {
        return ['AS', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL JOIN', 'CROSS JOIN', 'ON', 'WHERE', 'GROUP BY', 'ORDER BY', 'LIMIT', 'OFFSET'];
    }
    return SELECT_CONTEXT_KEYWORDS;
};

const dmlKeywordsAtCursor = (statementKind, activeClause) => {
    if (activeClause === 'WHERE') return [...CONDITION_KEYWORDS, 'ORDER BY', 'LIMIT', 'RETURNING'];
    if (activeClause === 'ORDER BY') return ['ASC', 'DESC', 'LIMIT'];
    if (activeClause === 'SET') return ['WHERE', 'RETURNING'];
    if (statementKind === 'DELETE') return ['FROM', 'WHERE', 'USING', 'RETURNING'];
    if (statementKind === 'UPDATE') return ['SET', 'WHERE'];
    return ['VALUES', 'SELECT', 'SET', 'RETURNING'];
};

const isPrimaryKey = (column) => column.key === 'PRI' || column.primary_key === true;

const tableDocumentation = (table) => {
    const columns = table.columns || [];
    const tableComment = table.comment ? `\n\n${table.comment}` : '';
    if (!columns.length) return `**${table.name}**${tableComment}\n\n_no column metadata loaded._`;
    const lines = columns.slice(0, 80).map(column => {
        const key = isPrimaryKey(column) ? 'pk' : '';
        const nullable = column.nullable === false ? 'no' : 'yes';
        return `| \`${column.name}\` | ${column.comment || ''} | ${column.type || ''} | ${key} | ${nullable} |`;
    });
    if (columns.length > 80) lines.push(`| ... | ${columns.length - 80} more columns | | | |`);
    return [
        `**${table.name}**${tableComment}`,
        '',
        '| column | comment | type | key | nullable |',
        '| --- | --- | --- | --- | --- |',
        ...lines,
    ].join('\n');
};

const isRoutine = (table) => ['function', 'procedure'].includes(table.object_type || table.type);

const tableSuggestion = (monaco, table, range) => {
    const objectType = table.object_type || table.type || 'table';
    const routine = isRoutine(table);
    return {
        label: table.name,
        kind: routine ? monaco.languages.CompletionItemKind.Function : monaco.languages.CompletionItemKind.Class,
        insertText: table.name,
        detail: routine
            ? objectType
            : `${objectType === 'view' ? 'view' : 'table'} • ${(table.columns || []).length} columns${table.comment ? ' • ' + table.comment : ''}`,
        documentation: { value: tableDocumentation(table) },
        sortText: `${routine ? '1' : '0'}_${table.name}`,
        range,
    };
};

const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

const databaseSuggestion = (monaco, database, range, inBacktick) => {
    const name = inBacktick || PLAIN_IDENTIFIER.test(database) ? database : `\`${database.replace(/`/g, '``')}\``;
    return {
        label: database,
        kind: monaco.languages.CompletionItemKind.Module,
        insertText: `${name}.`,
        detail: 'database',
        sortText: `3_${database}`,
        range,
        // 插入 `库.` 后立刻弹出该库的表
        command: { id: 'editor.action.triggerSuggest', title: '' },
    };
};

const keywordSuggestion = (monaco, keyword, range) => ({
    label: keyword,
    kind: monaco.languages.CompletionItemKind.Keyword,
    insertText: keyword,
    sortText: `2_${keyword}`,
    range,
});

const functionSuggestion = (monaco, fn, range) => {
    const { CompletionItemInsertTextRule, CompletionItemTag } = monaco.languages;
    return {
        label: fn.name,
        kind: monaco.languages.CompletionItemKind.Function,
        insertText: `${fn.name}($0)`,
        insertTextRules: CompletionItemInsertTextRule?.InsertAsSnippet,
        detail: fn.signatures[0] || `${fn.name}()`,
        documentation: [...fn.signatures.slice(1), fn.description].filter(Boolean).join('\n'),
        sortText: `4_${fn.name}`,
        tags: fn.deprecated && CompletionItemTag ? [CompletionItemTag.Deprecated] : undefined,
        range,
    };
};

const columnSuggestion = (monaco, column, range, tableName) => ({
    label: column.name,
    kind: monaco.languages.CompletionItemKind.Field,
    insertText: column.name,
    detail: `${column.type || ''}${column.comment ? ' - ' + column.comment : ''}${tableName ? ` (${tableName})` : ''}`,
    sortText: `${isPrimaryKey(column) ? '0' : '1'}_${column.name}`,
    range,
});

export const statementAtCursor = (text, cursorOffset) => {
    let statementStart = 0;
    let quote = '';
    let lineComment = false;
    let blockComment = false;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1] || '';

        if (lineComment) {
            if (char === '\n') lineComment = false;
            continue;
        }
        if (blockComment) {
            if (char === '*' && next === '/') {
                blockComment = false;
                index += 1;
            }
            continue;
        }
        if (quote) {
            if (char === '\\') {
                index += 1;
                continue;
            }
            if (char === quote) {
                if (next === quote) index += 1;
                else quote = '';
            }
            continue;
        }
        if (char === '-' && next === '-') {
            lineComment = true;
            index += 1;
            continue;
        }
        if (char === '/' && next === '*') {
            blockComment = true;
            index += 1;
            continue;
        }
        if (char === "'" || char === '"' || char === '`') {
            quote = char;
            continue;
        }
        if (char === ';') {
            if (cursorOffset <= index) {
                return {
                    text: text.slice(statementStart, index),
                    cursorOffset: Math.max(cursorOffset - statementStart, 0),
                };
            }
            statementStart = index + 1;
        }
    }

    return {
        text: text.slice(statementStart),
        cursorOffset: Math.max(cursorOffset - statementStart, 0),
    };
};

const modelOffsetAt = (model, position) => {
    if (typeof model.getOffsetAt === 'function') return model.getOffsetAt(position);
    const lines = model.getValue().split('\n');
    let offset = 0;
    for (let line = 1; line < position.lineNumber; line += 1) {
        offset += lines[line - 1].length + 1;
    }
    return offset + position.column - 1;
};

/** 读取一个（可能带引号的）标识符，返回 { name, end }；失败返回 null。 */
const readIdentifier = (text, start) => {
    const open = text[start];
    if (open === '`' || open === '"' || open === '[') {
        const close = open === '[' ? ']' : open;
        const end = text.indexOf(close, start + 1);
        if (end < 0) return null;
        return { name: text.slice(start + 1, end), end: end + 1 };
    }
    IDENT_REGEX.lastIndex = start;
    const match = IDENT_REGEX.exec(text);
    if (!match) return null;
    return { name: match[0], end: start + match[0].length };
};

const skipWhitespace = (text, index) => {
    while (index < text.length && /\s/.test(text[index])) index += 1;
    return index;
};

/** 读取 db.table 形式的名字：name 为最后一段，database 为它前面的一段（没有则为空）。 */
const readQualifiedName = (text, start) => {
    const ident = readIdentifier(text, start);
    if (!ident) return null;
    let { name, end } = ident;
    let database = '';
    while (text[end] === '.') {
        const part = readIdentifier(text, end + 1);
        if (!part) break;
        database = name;
        name = part.name;
        end = part.end;
    }
    return { name, database, end };
};

const RELATION_START_REGEX = /\b(FROM|JOIN|UPDATE|INTO)\b/gi;

const relationMapForStatement = (maskedStatement) => {
    // alias -> { database, name }；referencedTables 按出现顺序去重
    const aliases = new Map();
    const referencedTables = new Map();
    const addAlias = (alias, ref) => {
        aliases.set(alias, ref);
        const lower = alias.toLowerCase();
        if (!aliases.has(lower)) aliases.set(lower, ref);
    };

    let match;
    RELATION_START_REGEX.lastIndex = 0;
    while ((match = RELATION_START_REGEX.exec(maskedStatement)) !== null) {
        const allowList = match[1].toUpperCase() === 'FROM';
        let index = match.index + match[0].length;
        for (;;) {
            index = skipWhitespace(maskedStatement, index);
            const relation = readQualifiedName(maskedStatement, index);
            if (!relation || RELATION_KEYWORDS.has(relation.name.toUpperCase())) break;
            const ref = { database: relation.database, name: relation.name };
            const key = `${ref.database.toLowerCase()}.${ref.name.toLowerCase()}`;
            if (!referencedTables.has(key)) referencedTables.set(key, ref);
            addAlias(ref.name, ref);
            index = skipWhitespace(maskedStatement, relation.end);

            let aliasIdent = readIdentifier(maskedStatement, index);
            if (aliasIdent && aliasIdent.name.toUpperCase() === 'AS') {
                index = skipWhitespace(maskedStatement, aliasIdent.end);
                aliasIdent = readIdentifier(maskedStatement, index);
            }
            if (aliasIdent && !RELATION_KEYWORDS.has(aliasIdent.name.toUpperCase())) {
                addAlias(aliasIdent.name, ref);
                index = skipWhitespace(maskedStatement, aliasIdent.end);
            }

            if (!allowList || maskedStatement[index] !== ',') break;
            index += 1;
        }
    }
    return { aliases, referencedTables: [...referencedTables.values()] };
};

const findTable = (tables, name) => {
    if (!name) return undefined;
    const exact = tables.find(item => item.name === name);
    if (exact) return exact;
    const lower = name.toLowerCase();
    return tables.find(item => item.name.toLowerCase() === lower);
};

const resolveAlias = (aliases, alias) => (
    aliases.get(alias) || aliases.get(alias.toLowerCase()) || { database: '', name: alias }
);

const sameName = (a, b) => Boolean(a && b) && a.toLowerCase() === b.toLowerCase();

/**
 * 跨库元数据访问：只有数据源提供了 loadDatabases / loadDatabaseTables 时才启用。
 * 当前库的表直接用 getCurrentTables()，其他库的表按需加载。
 */
const createCatalog = ({ getCurrentTables, getCurrentDatabase, loadDatabases, loadDatabaseTables, loadFunctions }) => {
    const currentTables = () => getCurrentTables() || [];
    const currentDatabase = () => (getCurrentDatabase ? getCurrentDatabase() || '' : '');
    const supportsDatabases = typeof loadDatabases === 'function' && typeof loadDatabaseTables === 'function';

    const databases = async () => {
        if (!supportsDatabases) return [];
        try {
            return (await loadDatabases()) || [];
        } catch (e) {
            return [];
        }
    };

    const findDatabase = async (name) => (await databases()).find(db => sameName(db, name));

    /** 返回某个库的表；database 为空或为当前库时返回当前表，未知库返回 null。 */
    const tablesOf = async (database) => {
        if (!database || sameName(database, currentDatabase())) return currentTables();
        const actual = await findDatabase(database);
        if (!actual) return null;
        try {
            return (await loadDatabaseTables(actual)) || [];
        } catch (e) {
            return [];
        }
    };

    const resolveTable = async (ref) => {
        const tables = await tablesOf(ref.database);
        // 未识别的前缀（如 PostgreSQL 的 schema）退回当前表
        return findTable(tables || currentTables(), ref.name);
    };

    /** 当前服务器版本可用的内置函数；数据源未提供 loadFunctions 时为空。 */
    const functions = async () => {
        if (typeof loadFunctions !== 'function') return [];
        try {
            return (await loadFunctions()) || [];
        } catch (e) {
            return [];
        }
    };

    return { currentTables, databases, tablesOf, resolveTable, functions, supportsDatabases };
};

const referencedColumns = async (monaco, catalog, maskedStatement, range) => {
    const { referencedTables } = relationMapForStatement(maskedStatement);
    const scopedTables = referencedTables.length
        ? (await Promise.all(referencedTables.map(ref => catalog.resolveTable(ref)))).filter(Boolean)
        : catalog.currentTables();
    const showTable = scopedTables.length > 1;
    const seen = new Set();
    const suggestions = [];
    scopedTables.forEach(table => (table.columns || []).forEach(column => {
        if (seen.has(column.name)) return;
        seen.add(column.name);
        suggestions.push(columnSuggestion(monaco, column, range, showTable ? table.name : ''));
    }));
    return suggestions;
};

const QUALIFIER_REGEX = new RegExp(`[\`"]?(${IDENT}+)[\`"]?\\.[\`"]?${IDENT}*$`);
const RELATION_POSITION_REGEX = new RegExp(
    `\\b(?:FROM|JOIN|UPDATE|INTO|TABLE)\\s+(?:[\`"]?${IDENT}+[\`"]?\\.)?[\`"]?${IDENT}*$`, 'i',
);
const RELATION_LIST_REGEX = new RegExp(
    `\\bFROM\\s+([^;()]*?,\\s*)(?:[\`"]?${IDENT}+[\`"]?\\.)?[\`"]?${IDENT}*$`, 'i',
);

const isRelationPosition = (maskedBeforeCursor) => {
    if (RELATION_POSITION_REGEX.test(maskedBeforeCursor)) return true;
    // FROM a, b, | 逗号分隔的表列表
    const listMatch = maskedBeforeCursor.match(RELATION_LIST_REGEX);
    return Boolean(listMatch && !RELATION_LIST_TERMINATORS.test(listMatch[1]));
};

const statementKindOf = (maskedStatement) => (
    maskedStatement.replace(/^[\s(]+/, '').match(/^([A-Za-z]+)/)?.[1]?.toUpperCase() || ''
);

/** 表名位置的补全：`库.` 之后给出该库的表，否则给出当前库的表和其他库名。 */
const relationSuggestions = async (monaco, catalog, qualifier, range, inBacktick) => {
    if (qualifier) {
        const tables = await catalog.tablesOf(qualifier);
        return (tables || catalog.currentTables()).map(table => tableSuggestion(monaco, table, range));
    }
    const tables = catalog.currentTables().map(table => tableSuggestion(monaco, table, range));
    const databases = (await catalog.databases()).map(db => databaseSuggestion(monaco, db, range, inBacktick));
    return [...tables, ...databases];
};

/** 表达式位置的函数补全：只在已输入函数名前缀时给出，避免空白处弹出几百个函数。 */
const functionSuggestions = async (monaco, catalog, range) => {
    if (range.endColumn <= range.startColumn) return [];
    return (await catalog.functions()).map(fn => functionSuggestion(monaco, fn, range));
};

export const createSqlCompletion = (
    monaco,
    { getCurrentTables, getModelText, getCurrentDatabase, loadDatabases, loadDatabaseTables, loadFunctions },
    sqlKeywords,
) => ({
    triggerCharacters: ['.', ' ', '=', '`', '('],
    provideCompletionItems: async (model, position) => {
        const word = model.getWordUntilPosition(position);
        const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
        };
        const fullText = getModelText ? getModelText() : model.getValue();
        const current = statementAtCursor(fullText, modelOffsetAt(model, position));
        const textBeforeCursor = current.text.slice(0, current.cursorOffset);
        const scanBefore = scanSql(textBeforeCursor);
        if (scanBefore.inComment || scanBefore.quote === "'") return { suggestions: [] };

        const maskedBefore = scanBefore.masked;
        const maskedStatement = maskedBefore + scanSql(current.text.slice(current.cursorOffset)).masked;
        const relationPosition = isRelationPosition(maskedBefore);
        const qualifier = maskedBefore.match(QUALIFIER_REGEX)?.[1];

        // 双引号在 MySQL 里通常是字符串：只在表名位置或 "x". 之后补全
        if (scanBefore.quote === '"' && !relationPosition && !qualifier) return { suggestions: [] };

        const catalog = createCatalog({
            getCurrentTables, getCurrentDatabase, loadDatabases, loadDatabaseTables, loadFunctions,
        });

        if (qualifier && !relationPosition) {
            const { aliases } = relationMapForStatement(maskedStatement);
            const table = await catalog.resolveTable(resolveAlias(aliases, qualifier));
            return {
                suggestions: (table?.columns || []).map(column => columnSuggestion(monaco, column, range)),
            };
        }

        if (relationPosition) {
            return {
                suggestions: await relationSuggestions(monaco, catalog, qualifier, range, scanBefore.quote === '`'),
            };
        }

        if (scanBefore.quote === '`') {
            // 反引号内：给出当前语句可用的字段
            return { suggestions: await referencedColumns(monaco, catalog, maskedStatement, range) };
        }

        if (!shouldSuggestAfterWhitespace(textBeforeCursor)) return { suggestions: [] };

        let statementKind = statementKindOf(maskedStatement);
        const activeClause = activeClauseAt(maskedBefore);
        if ((statementKind === 'INSERT' || statementKind === 'REPLACE') && /\bSELECT\b/i.test(maskedBefore)) {
            statementKind = 'SELECT';
        }
        const allowedKeywords = new Set(sqlKeywords);

        if (statementKind === 'SELECT' || statementKind === 'WITH') {
            const columns = await referencedColumns(monaco, catalog, maskedStatement, range);
            const keywords = selectKeywordsAtCursor(activeClause)
                .filter(keyword => allowedKeywords.has(keyword))
                .map(keyword => keywordSuggestion(monaco, keyword, range));
            const functions = await functionSuggestions(monaco, catalog, range);
            return { suggestions: [...columns, ...keywords, ...functions] };
        }

        if (COLUMN_STATEMENT_KINDS.has(statementKind)) {
            const functions = await functionSuggestions(monaco, catalog, range);
            // INSERT ... VALUES (...) 里填的是值，不提示字段，只提示函数
            if (activeClause === 'VALUES') return { suggestions: functions };
            const columns = await referencedColumns(monaco, catalog, maskedStatement, range);
            const keywords = dmlKeywordsAtCursor(statementKind, activeClause)
                .filter(keyword => allowedKeywords.has(keyword))
                .map(keyword => keywordSuggestion(monaco, keyword, range));
            return { suggestions: [...columns, ...keywords, ...functions] };
        }

        return {
            suggestions: sqlKeywords.map(keyword => keywordSuggestion(monaco, keyword, range)),
        };
    },
});
