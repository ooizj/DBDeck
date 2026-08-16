const RELATION_KEYWORDS = new Set([
    'WHERE', 'ON', 'LIMIT', 'OFFSET', 'GROUP', 'ORDER', 'JOIN', 'LEFT', 'RIGHT',
    'INNER', 'FULL', 'CROSS', 'HAVING', 'UNION', 'INTERSECT', 'EXCEPT', 'RETURNING',
]);

const SELECT_CONTEXT_KEYWORDS = [
    'DISTINCT', 'FROM', 'AS', 'WHERE', 'AND', 'OR', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN',
    'INNER JOIN', 'FULL JOIN', 'ON', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT',
    'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT',
];

const WHITESPACE_COMPLETION_KEYWORDS = new Set([
    'SELECT', 'DISTINCT', 'WHERE', 'HAVING', 'ON', 'AND', 'OR', 'BY', 'NOT',
    'WHEN', 'THEN', 'ELSE', 'SET', 'VALUES',
]);

const isInsideSqlLiteralOrComment = (text) => {
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
        if (char === "'" || char === '"' || char === '`') quote = char;
    }

    return Boolean(quote || lineComment || blockComment);
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

const selectKeywordsAtCursor = (textBeforeCursor) => {
    const upper = textBeforeCursor.toUpperCase();
    const clauses = [
        ['GROUP BY', upper.lastIndexOf('GROUP BY')],
        ['ORDER BY', upper.lastIndexOf('ORDER BY')],
        ['HAVING', upper.lastIndexOf('HAVING')],
        ['WHERE', upper.lastIndexOf('WHERE')],
        ['ON', upper.lastIndexOf(' ON ')],
        ['JOIN', upper.lastIndexOf('JOIN')],
        ['FROM', upper.lastIndexOf('FROM')],
        ['SELECT', upper.lastIndexOf('SELECT')],
    ].filter(([, index]) => index >= 0).sort((left, right) => right[1] - left[1]);
    const activeClause = clauses[0]?.[0] || 'SELECT';

    if (activeClause === 'SELECT') return ['DISTINCT', 'FROM', 'AS'];
    if (activeClause === 'WHERE' || activeClause === 'HAVING') {
        return ['AND', 'OR', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET'];
    }
    if (activeClause === 'ON') {
        return ['AND', 'OR', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'WHERE', 'GROUP BY', 'ORDER BY', 'LIMIT'];
    }
    if (activeClause === 'GROUP BY') return ['HAVING', 'ORDER BY', 'LIMIT', 'OFFSET'];
    if (activeClause === 'ORDER BY') return ['LIMIT', 'OFFSET'];
    if (activeClause === 'FROM' || activeClause === 'JOIN') {
        return ['AS', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL JOIN', 'ON', 'WHERE', 'GROUP BY', 'ORDER BY', 'LIMIT', 'OFFSET'];
    }
    return SELECT_CONTEXT_KEYWORDS;
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

const tableSuggestion = (monaco, table, range) => ({
    label: table.name,
    kind: monaco.languages.CompletionItemKind.Class,
    insertText: table.name,
    detail: `table • ${(table.columns || []).length} columns${table.comment ? ' • ' + table.comment : ''}`,
    documentation: { value: tableDocumentation(table) },
    sortText: `0_${table.name}`,
    range,
});

const keywordSuggestion = (monaco, keyword, range) => ({
    label: keyword,
    kind: monaco.languages.CompletionItemKind.Keyword,
    insertText: keyword,
    sortText: `2_${keyword}`,
    range,
});

const columnSuggestion = (monaco, column, range) => ({
    label: column.name,
    kind: monaco.languages.CompletionItemKind.Field,
    insertText: column.name,
    detail: `${column.type || ''}${column.comment ? ' - ' + column.comment : ''}`,
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

const relationMapForStatement = (statement) => {
    const aliases = new Map();
    const referencedTables = new Set();
    const relationRegex = /(?:FROM|JOIN|UPDATE|INTO)\s+[`"]?([\w$]+)[`"]?(?:\s+(?:AS\s+)?[`"]?([\w$]+)[`"]?)?/gi;
    let match;
    while ((match = relationRegex.exec(statement)) !== null) {
        const tableName = match[1];
        const possibleAlias = match[2];
        referencedTables.add(tableName);
        aliases.set(tableName, tableName);
        if (possibleAlias && !RELATION_KEYWORDS.has(possibleAlias.toUpperCase())) {
            aliases.set(possibleAlias, tableName);
        }
    }
    return { aliases, referencedTables };
};

const referencedColumns = (monaco, tables, statement, range) => {
    const { referencedTables } = relationMapForStatement(statement);
    const scopedTables = referencedTables.size
        ? tables.filter(table => referencedTables.has(table.name))
        : tables;
    const seen = new Set();
    const suggestions = [];
    scopedTables.forEach(table => (table.columns || []).forEach(column => {
        if (seen.has(column.name)) return;
        seen.add(column.name);
        suggestions.push(columnSuggestion(monaco, column, range));
    }));
    return suggestions;
};

export const createSqlCompletion = (
    monaco,
    { getCurrentTables, getModelText },
    sqlKeywords,
) => ({
    triggerCharacters: ['.', ' ', '='],
    provideCompletionItems: (model, position) => {
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
        const relationPosition = /(?:^|\s)(?:FROM|JOIN|UPDATE|INTO)\s+[`"]?[\w$]*$/i.test(textBeforeCursor);

        if (isInsideSqlLiteralOrComment(textBeforeCursor)) return { suggestions: [] };

        const tables = getCurrentTables();

        if (textBeforeCursor.endsWith('.')) {
            const alias = textBeforeCursor.match(/([a-zA-Z0-9_$]+)\.$/)?.[1];
            if (!alias) return { suggestions: [] };
            const { aliases } = relationMapForStatement(current.text);
            const tableName = aliases.get(alias) || alias;
            const table = tables.find(item => item.name === tableName);
            return {
                suggestions: (table?.columns || []).map(column => columnSuggestion(monaco, column, range)),
            };
        }

        if (relationPosition) {
            return { suggestions: tables.map(table => tableSuggestion(monaco, table, range)) };
        }

        if (!shouldSuggestAfterWhitespace(textBeforeCursor)) return { suggestions: [] };

        const statementKind = current.text.trimStart().match(/^([A-Za-z]+)/)?.[1]?.toUpperCase() || '';
        if (statementKind === 'SELECT' || statementKind === 'WITH') {
            const columns = referencedColumns(monaco, tables, current.text, range);
            const allowedKeywords = new Set(sqlKeywords);
            const keywords = selectKeywordsAtCursor(textBeforeCursor)
                .filter(keyword => allowedKeywords.has(keyword))
                .map(keyword => keywordSuggestion(monaco, keyword, range));
            return { suggestions: [...columns, ...keywords] };
        }

        return {
            suggestions: sqlKeywords.map(keyword => keywordSuggestion(monaco, keyword, range)),
        };
    },
});
