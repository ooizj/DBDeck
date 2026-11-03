import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildDetailRows,
    buildSearchCsv,
    buildSearchSheets,
    sheetName,
} from '../../web_ui/js/components/TableSearchModal.js';

const hits = [
    {
        database: 'shop',
        table: 'orders',
        columns: ['id', 'title', 'note'],
        rows: [[1, 'apple "pie"', 'apple, red'], [2, 'banana', null]],
        matched: [['title', 'note'], ['title']],
        record_ids: ['1', '2'],
        column_comments: { title: '标题', note: '' },
    },
];

test('detail rows expand one row per matched field', () => {
    const rows = buildDetailRows(hits);
    assert.deepEqual(rows.map(r => [r.recordId, r.column, r.comment, r.value]), [
        ['1', 'title', '标题', 'apple "pie"'],
        ['1', 'note', '', 'apple, red'],
        ['2', 'title', '标题', 'banana'],
    ]);
});

test('csv export has BOM, header and escaped quotes', () => {
    const csv = buildSearchCsv(buildDetailRows(hits));
    assert.ok(csv.startsWith('﻿"数据库","来源表","记录ID","匹配字段","字段注释","匹配内容"'));
    assert.ok(csv.includes('"shop","orders","1","title","标题","apple ""pie"""'));
    assert.ok(csv.includes('"apple, red"'));
});

test('xlsx sheets: detail first, then full rows per table with matched fields', () => {
    const sheets = buildSearchSheets(hits, buildDetailRows(hits));
    assert.deepEqual(sheets.map(s => s.name), ['搜索明细', 'orders']);
    assert.deepEqual(sheets[1].header, ['命中字段', 'id', 'title', 'note']);
    assert.deepEqual(sheets[1].rows[1], ['title', '2', 'banana', '']);
});

test('sheet names are sanitized, truncated and unique', () => {
    const used = new Set();
    assert.equal(sheetName('a/b:c', used), 'a_b_c');
    const long = 'x'.repeat(40);
    assert.equal(sheetName(long, used), 'x'.repeat(31));
    assert.equal(sheetName(long, used), 'x'.repeat(29) + '~2');
    assert.equal(sheetName('A_B_C', used), 'A_B_C~2');
});
