import assert from 'node:assert/strict';
import test from 'node:test';

import postgresqlProvider from '../../web_ui/js/sources/postgresql.js';
import { quoteTableName } from '../../web_ui/js/utils/sqlHelpers.js';

const monaco = {
    languages: {
        CompletionItemKind: { Class: 'class', Field: 'field', Function: 'function', Keyword: 'keyword' },
        CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
        CompletionItemTag: { Deprecated: 1 },
    },
};

// 默认模式的表用原名，其他模式的表用「模式.表名」，与后端元数据一致
const tables = [
    { name: 'review', columns: [{ name: 'id' }, { name: 'title' }] },
    { name: 'xapp_review.review', columns: [{ name: 'id', primary_key: true }, { name: 'status' }] },
    { name: 'xapp_review.task', columns: [{ name: 'review_id' }] },
];

const complete = async (textWithCursor) => {
    const cursorOffset = textWithCursor.indexOf('|');
    const text = textWithCursor.slice(0, cursorOffset) + textWithCursor.slice(cursorOffset + 1);
    const model = {
        getValue: () => text,
        getLineContent: () => text,
        getWordUntilPosition: (position) => {
            const word = text.slice(0, position.column - 1).match(/[A-Za-z0-9_$]+$/)?.[0] || '';
            return { startColumn: position.column - word.length, endColumn: position.column };
        },
    };
    const completion = postgresqlProvider.registerCompletion(monaco, {
        getCurrentTables: () => tables,
        getModelText: () => text,
    });
    const result = await completion.provideCompletionItems(model, { lineNumber: 1, column: cursorOffset + 1 });
    return result.suggestions.map(item => item.label);
};

test('schema prefix lists only that schema tables without repeating the prefix', async () => {
    assert.deepEqual(await complete('SELECT * FROM xapp_review.|'), ['review', 'task']);
    assert.deepEqual(await complete('SELECT * FROM xapp_review.ta|'), ['review', 'task']);
});

test('relation position offers qualified names of other schemas', async () => {
    const labels = await complete('SELECT * FROM |');
    assert.deepEqual(labels, ['review', 'xapp_review.review', 'xapp_review.task']);
});

test('columns resolve to the schema-qualified table, not the same-named default one', async () => {
    assert.deepEqual(await complete('SELECT r.| FROM xapp_review.review r'), ['id', 'status']);
    assert.deepEqual(await complete('SELECT review.| FROM xapp_review.review'), ['id', 'status']);
    assert.deepEqual(await complete('SELECT r.| FROM review r'), ['id', 'title']);
    const labels = await complete('SELECT | FROM xapp_review.review r JOIN xapp_review.task t ON t.review_id = r.id');
    assert.equal(labels.includes('status'), true);
    assert.equal(labels.includes('review_id'), true);
    assert.equal(labels.includes('title'), false);
});

test('generated SQL quotes schema and table separately', () => {
    const table = tables[1];
    assert.equal(postgresqlProvider.buildPreviewQuery(table), 'SELECT * FROM "xapp_review"."review" LIMIT 100;');
    assert.equal(postgresqlProvider.buildSelectQuery(table), 'SELECT "id", "status" FROM "xapp_review"."review";');
    assert.equal(postgresqlProvider.buildPreviewQuery(tables[0]), 'SELECT * FROM "review" LIMIT 100;');
});

test('quoteTableName only splits schema for PostgreSQL', () => {
    assert.equal(quoteTableName('xapp_review.review', 'postgresql'), '"xapp_review"."review"');
    assert.equal(quoteTableName('we"ird', 'postgresql'), '"we""ird"');
    assert.equal(quoteTableName('a.b', 'mysql'), '`a.b`');
    assert.equal(quoteTableName('a.b', 'sqlite'), '"a.b"');
});
