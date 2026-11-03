import assert from 'node:assert/strict';
import test from 'node:test';

import mysqlProvider from '../../web_ui/js/sources/mysql.js';
import sqliteProvider from '../../web_ui/js/sources/sqlite.js';
import { mysqlFunctionsForVersion } from '../../web_ui/js/utils/sqlFunctions.js';


const monaco = {
    languages: {
        CompletionItemKind: {
            Class: 'class',
            Field: 'field',
            Function: 'function',
            Keyword: 'keyword',
        },
        CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
        CompletionItemTag: { Deprecated: 1 },
    },
};

const tables = [
    {
        name: 'users',
        columns: [
            { name: 'id', type: 'bigint', key: 'PRI' },
            { name: 'name', type: 'varchar' },
        ],
    },
    {
        name: 'audit_log',
        columns: [{ name: 'action', type: 'varchar' }],
    },
];

const complete = async (textWithCursor, context = {}) => {
    const cursorOffset = textWithCursor.indexOf('|');
    const text = textWithCursor.slice(0, cursorOffset) + textWithCursor.slice(cursorOffset + 1);
    const before = text.slice(0, cursorOffset);
    const lineNumber = before.split('\n').length;
    const lineStart = before.lastIndexOf('\n') + 1;
    const column = cursorOffset - lineStart + 1;
    const lines = text.split('\n');
    const model = {
        getValue: () => text,
        getLineContent: (line) => lines[line - 1],
        getWordUntilPosition: (position) => {
            const prefix = lines[position.lineNumber - 1].slice(0, position.column - 1);
            const word = prefix.match(/[A-Za-z0-9_$]+$/)?.[0] || '';
            return {
                startColumn: position.column - word.length,
                endColumn: position.column,
            };
        },
    };
    const completion = mysqlProvider.registerCompletion(monaco, {
        getCurrentTables: () => tables,
        getModelText: () => text,
        ...context,
    });
    return (await completion.provideCompletionItems(model, { lineNumber, column })).suggestions;
};


test('SELECT list completion suggests columns instead of unrelated DDL keywords', async () => {
    const suggestions = (await complete('SELECT | FROM users'));
    const labels = suggestions.map(item => item.label);

    assert.deepEqual(labels.slice(0, 2), ['id', 'name']);
    assert.equal(labels.includes('ALTER TABLE'), false);
});


test('table alias completion is isolated to the statement containing the cursor', async () => {
    const suggestions = (await complete([
        'SELECT u.| FROM users u;',
        'SELECT * FROM audit_log u;',
    ].join('\n')));
    const labels = suggestions.map(item => item.label);

    assert.deepEqual(labels, ['id', 'name']);
    assert.equal(labels.includes('action'), false);
});


test('WHERE completion suggests fields and condition keywords but not FROM or DDL', async () => {
    const suggestions = (await complete('SELECT * FROM users WHERE |'));
    const labels = suggestions.map(item => item.label);

    assert.equal(labels.includes('id'), true);
    assert.equal(labels.includes('name'), true);
    assert.equal(labels.includes('AND'), true);
    assert.equal(labels.includes('OR'), true);
    assert.equal(labels.includes('FROM'), false);
    assert.equal(labels.includes('ALTER TABLE'), false);
});


test('multiline SELECT completion uses the whole current statement', async () => {
    const suggestions = (await complete('SELECT\n  |\nFROM users'));
    const labels = suggestions.map(item => item.label);

    assert.deepEqual(labels.slice(0, 2), ['id', 'name']);
});


test('completed identifiers followed by whitespace do not suggest another field', async () => {
    const inputs = [
        'SELECT id | FROM users',
        'SELECT users.id | FROM users',
        'SELECT COUNT(id) | FROM users',
        'SELECT * FROM users |',
        'SELECT * FROM users u |',
        'SELECT * FROM users WHERE id |',
        'SELECT * FROM users u WHERE u.id |',
        'SELECT * FROM users WHERE id = 42 |',
        "SELECT * FROM users WHERE name = 'alice' |",
        'SELECT id FROM users GROUP BY id |',
        'SELECT id FROM users ORDER BY id |',
        'SELECT id FROM users LIMIT 10 |',
    ];

    for (const input of inputs) {
        assert.deepEqual((await complete(input)), [], input);
    }
});


test('relation keywords still trigger table completion', async () => {
    const inputs = [
        'SELECT * FROM |',
        'SELECT * FROM users JOIN |',
        'UPDATE |',
        'INSERT INTO |',
    ];

    for (const input of inputs) {
        const labels = (await complete(input)).map(item => item.label);
        assert.deepEqual(labels, ['users', 'audit_log'], input);
    }
});


test('field completion resumes after an operator or SELECT-list comma', async () => {
    const inputs = [
        'SELECT | FROM users',
        'SELECT id, | FROM users',
        'SELECT * FROM users WHERE |',
        'SELECT * FROM users WHERE id = |',
        'SELECT * FROM users WHERE id = 1 AND |',
        'SELECT * FROM users WHERE id = 1 OR |',
        'SELECT id FROM users GROUP BY |',
        'SELECT id FROM users ORDER BY |',
    ];

    for (const input of inputs) {
        const labels = (await complete(input)).map(item => item.label);
        assert.equal(labels.includes('id'), true, input);
        assert.equal(labels.includes('name'), true, input);
    }
});


test('equals immediately triggers field completion', async () => {
    const completion = mysqlProvider.registerCompletion(monaco, {
        getCurrentTables: () => tables,
        getModelText: () => '',
    });
    const labels = (await complete('SELECT * FROM users WHERE id =|')).map(item => item.label);

    assert.equal(completion.triggerCharacters.includes('='), true);
    assert.equal(labels.includes('id'), true);
    assert.equal(labels.includes('name'), true);
});


test('completion stays closed inside SQL literals and comments', async () => {
    const inputs = [
        "SELECT * FROM users WHERE name = 'alice |'",
        'SELECT * FROM users -- customer |',
        'SELECT * FROM users /* customer | */',
    ];

    for (const input of inputs) {
        assert.deepEqual((await complete(input)), [], input);
    }
});


test('leading comments do not hide SELECT field completion', async () => {
    const labels = (await complete('-- 查询用户\nSELECT | FROM users')).map(item => item.label);

    assert.deepEqual(labels.slice(0, 2), ['id', 'name']);
});


test('UPDATE / DELETE / INSERT column positions suggest fields of the target table', async () => {
    const inputs = [
        'UPDATE users SET |',
        'UPDATE users SET name = |',
        'UPDATE users u SET u.name = 1 WHERE |',
        'DELETE FROM users WHERE |',
        'INSERT INTO users (|',
        'INSERT INTO users (id, |',
    ];

    for (const input of inputs) {
        const labels = (await complete(input)).map(item => item.label);
        assert.equal(labels.includes('id'), true, input);
        assert.equal(labels.includes('name'), true, input);
        assert.equal(labels.includes('action'), false, input);
    }
    assert.deepEqual((await complete('INSERT INTO users (id) VALUES (|')), []);
});


test('alias and table lookups are case-insensitive and handle partial words', async () => {
    assert.deepEqual((await complete('SELECT U.| FROM Users u')).map(item => item.label), ['id', 'name']);
    assert.deepEqual((await complete('SELECT u.na| FROM users u')).map(item => item.label), ['id', 'name']);
    assert.deepEqual((await complete('SELECT `u`.| FROM `users` AS `u`')).map(item => item.label), ['id', 'name']);
});


test('comma separated and schema qualified relations are recognised', async () => {
    const labels = (await complete('SELECT | FROM users u, audit_log a')).map(item => item.label);
    assert.equal(labels.includes('name'), true);
    assert.equal(labels.includes('action'), true);

    assert.deepEqual((await complete('SELECT a.| FROM mydb.users u, mydb.audit_log a')).map(item => item.label), ['action']);
    assert.deepEqual((await complete('SELECT * FROM users, |')).map(item => item.label), ['users', 'audit_log']);
    assert.deepEqual((await complete('SELECT * FROM mydb.|')).map(item => item.label), ['users', 'audit_log']);
    assert.deepEqual((await complete('SELECT * FROM `|')).map(item => item.label), ['users', 'audit_log']);
});


test('clause detection ignores keywords inside identifiers and string literals', async () => {
    const labels = (await complete("SELECT valid_from, | FROM users WHERE name = 'where'")).map(item => item.label);
    assert.equal(labels.includes('DISTINCT'), true);
    assert.equal(labels.includes('AND'), false);

    const whereLabels = (await complete("SELECT * FROM users WHERE name = 'from' AND |")).map(item => item.label);
    assert.equal(whereLabels.includes('AND'), true);
    assert.equal(whereLabels.includes('AS'), false);
});


test('MySQL keyword list covers clause keywords offered in context', async () => {
    const selectLabels = (await complete('SELECT | FROM users')).map(item => item.label);
    assert.equal(selectLabels.includes('DISTINCT'), true);

    const orderLabels = (await complete('SELECT * FROM users ORDER BY id d|')).map(item => item.label);
    assert.equal(orderLabels.includes('DESC'), true);
});


const crossDbContext = () => {
    const loaded = [];
    const otherTables = {
        crm: [
            { name: 'orders', columns: [{ name: 'order_id', type: 'bigint', primary_key: true }, { name: 'user_id', type: 'bigint' }] },
        ],
    };
    return {
        loaded,
        getCurrentSource: () => ({ database: 'app' }),
        loadDatabases: async () => ['app', 'crm', 'my-db'],
        loadDatabaseTables: async (database) => {
            loaded.push(database);
            return otherTables[database] || [];
        },
    };
};


test('FROM and JOIN positions suggest current tables plus other databases', async () => {
    for (const input of ['SELECT * FROM |', 'SELECT * FROM users u JOIN |', 'SELECT * FROM users u LEFT JOIN |', 'UPDATE |']) {
        const suggestions = await complete(input, crossDbContext());
        const labels = suggestions.map(item => item.label);
        assert.deepEqual(labels, ['users', 'audit_log', 'app', 'crm', 'my-db'], input);
        const crm = suggestions.find(item => item.label === 'crm');
        assert.equal(crm.insertText, 'crm.');
        assert.equal(crm.command.id, 'editor.action.triggerSuggest');
    }
    const quoted = (await complete('SELECT * FROM |', crossDbContext())).find(item => item.label === 'my-db');
    assert.equal(quoted.insertText, '`my-db`.');
});


test('database qualifier in FROM/JOIN suggests tables of that database', async () => {
    const ctx = crossDbContext();
    assert.deepEqual((await complete('SELECT * FROM users u JOIN crm.|', ctx)).map(item => item.label), ['orders']);
    assert.deepEqual((await complete('SELECT * FROM crm.or|', ctx)).map(item => item.label), ['orders']);
    assert.deepEqual((await complete('SELECT * FROM users, `crm`.|', ctx)).map(item => item.label), ['orders']);
    // 当前库前缀直接用已加载的表
    assert.deepEqual((await complete('SELECT * FROM app.|', ctx)).map(item => item.label), ['users', 'audit_log']);
    assert.deepEqual(ctx.loaded, ['crm', 'crm', 'crm']);
});


test('columns of tables joined from other databases are suggested', async () => {
    const ctx = crossDbContext();
    assert.deepEqual(
        (await complete('SELECT o.| FROM users u JOIN crm.orders o ON o.user_id = u.id', ctx)).map(item => item.label),
        ['order_id', 'user_id'],
    );
    const labels = (await complete('SELECT * FROM users u JOIN crm.orders o ON |', ctx)).map(item => item.label);
    assert.equal(labels.includes('id'), true);
    assert.equal(labels.includes('order_id'), true);
});


test('without cross-database loaders, qualified names fall back to current tables', async () => {
    assert.deepEqual((await complete('SELECT * FROM |')).map(item => item.label), ['users', 'audit_log']);
    assert.deepEqual((await complete('SELECT * FROM other.|')).map(item => item.label), ['users', 'audit_log']);
});


const versionContext = (version) => ({ loadServerVersion: async () => version });
const functionNames = (version) => new Set(mysqlFunctionsForVersion(version).map(fn => fn.name));


test('MySQL function catalog follows the server version', () => {
    const v57 = functionNames('5.7.25-log');
    assert.equal(v57.has('JSON_EXTRACT'), true);
    assert.equal(v57.has('JSON_PRETTY'), true);
    assert.equal(v57.has('PASSWORD'), true);
    assert.equal(v57.has('ROW_NUMBER'), false);
    assert.equal(v57.has('REGEXP_LIKE'), false);

    assert.equal(functionNames('5.7.21').has('JSON_PRETTY'), false);
    assert.equal(functionNames('5.7.7').has('JSON_EXTRACT'), false);

    const v80 = functionNames('8.0.15');
    assert.equal(v80.has('ROW_NUMBER'), true);
    assert.equal(v80.has('PASSWORD'), false);
    assert.equal(v80.has('FORMAT_BYTES'), false);
    assert.equal(functionNames('8.0.16').has('FORMAT_BYTES'), true);
    assert.equal(functionNames('8.0.20').has('JSON_VALUE'), false);
    assert.equal(functionNames('8.0.21').has('JSON_VALUE'), true);

    assert.equal(functionNames('8.4.3').has('VECTOR_DIM'), false);
    assert.equal(functionNames('9.1.0').has('VECTOR_DIM'), true);
    assert.equal(functionNames('26.10.0').has('VECTOR_DIM'), true);

    // 版本未知：只给仍可用的函数；MariaDB 函数集不同，不提示
    assert.equal(functionNames('').has('PASSWORD'), false);
    assert.equal(functionNames('').has('CONCAT'), true);
    assert.equal(functionNames('10.11.6-MariaDB').size, 0);
});


test('typed prefixes in expression positions suggest version-specific functions', async () => {
    const v80 = (await complete('SELECT ROW_|  FROM users', versionContext('8.0.36'))).map(item => item.label);
    assert.equal(v80.includes('ROW_NUMBER'), true);
    const v57 = (await complete('SELECT ROW_|  FROM users', versionContext('5.7.25'))).map(item => item.label);
    assert.equal(v57.includes('ROW_NUMBER'), false);
    assert.equal(v57.includes('ROW_COUNT'), true);

    const concat = (await complete('SELECT * FROM users WHERE name = CONC|', versionContext('8.0.36')))
        .find(item => item.label === 'CONCAT');
    assert.equal(concat.kind, 'function');
    assert.equal(concat.insertText, 'CONCAT($0)');
    assert.equal(concat.insertTextRules, 4);
    assert.equal(concat.detail, 'CONCAT(str1,str2,...)');

    const password = (await complete('SELECT PASS|', versionContext('5.7.25'))).find(item => item.label === 'PASSWORD');
    assert.deepEqual(password.tags, [1]);

    const values = (await complete('INSERT INTO users (id, name) VALUES (1, NO|)', versionContext('8.0.36')))
        .map(item => item.label);
    assert.equal(values.includes('NOW'), true);
    assert.equal(values.includes('name'), false);
});


test('functions are not offered without a prefix, outside expressions or for SQLite', async () => {
    const ctx = versionContext('8.0.36');
    const blank = await complete('SELECT | FROM users', ctx);
    assert.equal(blank.some(item => item.kind === 'function'), false);
    assert.deepEqual((await complete('SELECT * FROM us|', ctx)).map(item => item.label), ['users', 'audit_log']);
    assert.deepEqual((await complete('SELECT u.na| FROM users u', ctx)).map(item => item.label), ['id', 'name']);

    const failing = { loadServerVersion: async () => { throw new Error('offline'); } };
    assert.equal((await complete('SELECT CONC| FROM users', failing)).some(item => item.kind === 'function'), false);

    const sqlite = sqliteProvider.registerCompletion(monaco, {
        getCurrentTables: () => tables,
        getModelText: () => 'SELECT CONC',
        loadServerVersion: async () => '3.45.0',
    });
    const model = {
        getValue: () => 'SELECT CONC',
        getLineContent: () => 'SELECT CONC',
        getWordUntilPosition: () => ({ startColumn: 8, endColumn: 12 }),
    };
    const { suggestions } = await sqlite.provideCompletionItems(model, { lineNumber: 1, column: 12 });
    assert.equal(suggestions.some(item => item.kind === 'function'), false);
});
