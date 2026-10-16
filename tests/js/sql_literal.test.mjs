import assert from 'node:assert/strict';
import test from 'node:test';

import { formatSqlLiteral } from '../../web_ui/js/utils/sqlHelpers.js';

const tricky = "it's C:\\new\nline\r\n\tend";

test('scalar values keep their SQL types', () => {
    for (const dialect of ['mysql', 'postgresql', 'sqlite']) {
        assert.equal(formatSqlLiteral(null, dialect), 'NULL');
        assert.equal(formatSqlLiteral(undefined, dialect), 'NULL');
        assert.equal(formatSqlLiteral(12.5, dialect), '12.5');
        assert.equal(formatSqlLiteral(Number.NaN, dialect), 'NULL');
        assert.equal(formatSqlLiteral(true, dialect), 'TRUE');
    }
});

test('MySQL escapes backslashes, quotes and control characters on one line', () => {
    const literal = formatSqlLiteral(tricky, 'mysql');
    assert.equal(literal, "'it\\'s C:\\\\new\\nline\\r\\n\\tend'");
    assert.doesNotMatch(literal, /[\n\r]/);
});

test('PostgreSQL uses E-strings only when control characters are present', () => {
    assert.equal(formatSqlLiteral("C:\\path it's", 'postgresql'), "'C:\\path it''s'");
    const literal = formatSqlLiteral(tricky, 'postgresql');
    assert.equal(literal, "E'it\\'s C:\\\\new\\nline\\r\\n\\tend'");
    assert.doesNotMatch(literal, /[\n\r]/);
});

test('SQLite concatenates char() for control characters', () => {
    assert.equal(formatSqlLiteral("C:\\path it's", 'sqlite'), "'C:\\path it''s'");
    assert.equal(
        formatSqlLiteral("a\nb's", 'sqlite'),
        "'a' || char(10) || 'b''s'",
    );
    assert.equal(formatSqlLiteral('\n', 'sqlite'), 'char(10)');
});

test('objects are exported as JSON text', () => {
    assert.equal(formatSqlLiteral({ a: "x'y" }, 'sqlite'), `'{"a":"x''y"}'`);
});
