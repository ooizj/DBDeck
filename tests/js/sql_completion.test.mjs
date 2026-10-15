import assert from 'node:assert/strict';
import test from 'node:test';

import mysqlProvider from '../../web_ui/js/sources/mysql.js';


const monaco = {
    languages: {
        CompletionItemKind: {
            Class: 'class',
            Field: 'field',
            Keyword: 'keyword',
        },
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

const complete = (textWithCursor) => {
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
    });
    return completion.provideCompletionItems(model, { lineNumber, column }).suggestions;
};


test('SELECT list completion suggests columns instead of unrelated DDL keywords', () => {
    const suggestions = complete('SELECT | FROM users');
    const labels = suggestions.map(item => item.label);

    assert.deepEqual(labels.slice(0, 2), ['id', 'name']);
    assert.equal(labels.includes('ALTER TABLE'), false);
});


test('table alias completion is isolated to the statement containing the cursor', () => {
    const suggestions = complete([
        'SELECT u.| FROM users u;',
        'SELECT * FROM audit_log u;',
    ].join('\n'));
    const labels = suggestions.map(item => item.label);

    assert.deepEqual(labels, ['id', 'name']);
    assert.equal(labels.includes('action'), false);
});


test('WHERE completion suggests fields and condition keywords but not FROM or DDL', () => {
    const suggestions = complete('SELECT * FROM users WHERE |');
    const labels = suggestions.map(item => item.label);

    assert.equal(labels.includes('id'), true);
    assert.equal(labels.includes('name'), true);
    assert.equal(labels.includes('AND'), true);
    assert.equal(labels.includes('OR'), true);
    assert.equal(labels.includes('FROM'), false);
    assert.equal(labels.includes('ALTER TABLE'), false);
});


test('multiline SELECT completion uses the whole current statement', () => {
    const suggestions = complete('SELECT\n  |\nFROM users');
    const labels = suggestions.map(item => item.label);

    assert.deepEqual(labels.slice(0, 2), ['id', 'name']);
});


test('completed identifiers followed by whitespace do not suggest another field', () => {
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
        assert.deepEqual(complete(input), [], input);
    }
});


test('relation keywords still trigger table completion', () => {
    const inputs = [
        'SELECT * FROM |',
        'SELECT * FROM users JOIN |',
        'UPDATE |',
        'INSERT INTO |',
    ];

    for (const input of inputs) {
        const labels = complete(input).map(item => item.label);
        assert.deepEqual(labels, ['users', 'audit_log'], input);
    }
});


test('field completion resumes after an operator or SELECT-list comma', () => {
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
        const labels = complete(input).map(item => item.label);
        assert.equal(labels.includes('id'), true, input);
        assert.equal(labels.includes('name'), true, input);
    }
});


test('equals immediately triggers field completion', () => {
    const completion = mysqlProvider.registerCompletion(monaco, {
        getCurrentTables: () => tables,
        getModelText: () => '',
    });
    const labels = complete('SELECT * FROM users WHERE id =|').map(item => item.label);

    assert.equal(completion.triggerCharacters.includes('='), true);
    assert.equal(labels.includes('id'), true);
    assert.equal(labels.includes('name'), true);
});


test('completion stays closed inside SQL literals and comments', () => {
    const inputs = [
        "SELECT * FROM users WHERE name = 'alice |'",
        'SELECT * FROM users -- customer |',
        'SELECT * FROM users /* customer | */',
    ];

    for (const input of inputs) {
        assert.deepEqual(complete(input), [], input);
    }
});


test('leading comments do not hide SELECT field completion', () => {
    const labels = complete('-- 查询用户\nSELECT | FROM users').map(item => item.label);

    assert.deepEqual(labels.slice(0, 2), ['id', 'name']);
});


test('UPDATE / DELETE / INSERT column positions suggest fields of the target table', () => {
    const inputs = [
        'UPDATE users SET |',
        'UPDATE users SET name = |',
        'UPDATE users u SET u.name = 1 WHERE |',
        'DELETE FROM users WHERE |',
        'INSERT INTO users (|',
        'INSERT INTO users (id, |',
    ];

    for (const input of inputs) {
        const labels = complete(input).map(item => item.label);
        assert.equal(labels.includes('id'), true, input);
        assert.equal(labels.includes('name'), true, input);
        assert.equal(labels.includes('action'), false, input);
    }
    assert.deepEqual(complete('INSERT INTO users (id) VALUES (|'), []);
});


test('alias and table lookups are case-insensitive and handle partial words', () => {
    assert.deepEqual(complete('SELECT U.| FROM Users u').map(item => item.label), ['id', 'name']);
    assert.deepEqual(complete('SELECT u.na| FROM users u').map(item => item.label), ['id', 'name']);
    assert.deepEqual(complete('SELECT `u`.| FROM `users` AS `u`').map(item => item.label), ['id', 'name']);
});


test('comma separated and schema qualified relations are recognised', () => {
    const labels = complete('SELECT | FROM users u, audit_log a').map(item => item.label);
    assert.equal(labels.includes('name'), true);
    assert.equal(labels.includes('action'), true);

    assert.deepEqual(complete('SELECT a.| FROM mydb.users u, mydb.audit_log a').map(item => item.label), ['action']);
    assert.deepEqual(complete('SELECT * FROM users, |').map(item => item.label), ['users', 'audit_log']);
    assert.deepEqual(complete('SELECT * FROM mydb.|').map(item => item.label), ['users', 'audit_log']);
    assert.deepEqual(complete('SELECT * FROM `|').map(item => item.label), ['users', 'audit_log']);
});


test('clause detection ignores keywords inside identifiers and string literals', () => {
    const labels = complete("SELECT valid_from, | FROM users WHERE name = 'where'").map(item => item.label);
    assert.equal(labels.includes('DISTINCT'), true);
    assert.equal(labels.includes('AND'), false);

    const whereLabels = complete("SELECT * FROM users WHERE name = 'from' AND |").map(item => item.label);
    assert.equal(whereLabels.includes('AND'), true);
    assert.equal(whereLabels.includes('AS'), false);
});


test('MySQL keyword list covers clause keywords offered in context', () => {
    const selectLabels = complete('SELECT | FROM users').map(item => item.label);
    assert.equal(selectLabels.includes('DISTINCT'), true);

    const orderLabels = complete('SELECT * FROM users ORDER BY id d|').map(item => item.label);
    assert.equal(orderLabels.includes('DESC'), true);
});
