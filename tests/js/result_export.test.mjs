import assert from 'node:assert/strict';
import test from 'node:test';

import ResultArea, { alignExportColumns, bytesToBase64 } from '../../web_ui/js/components/ResultArea.js';


test('successful native result export reports a saved file instead of copying text', async () => {
    const emitted = [];
    const messages = [];
    globalThis.window = {
        pywebview: {
            api: {
                async save_file() {
                    return { success: true, path: '/tmp/query-result.csv' };
                },
            },
        },
    };
    globalThis.ElementPlus = {
        ElMessage: {
            success(message) { messages.push(message); },
            error() {},
        },
    };
    const context = {
        $emit(event, payload) { emitted.push({ event, payload }); },
    };

    await ResultArea.methods._saveFile.call(
        context,
        'id,name\n1,Ada',
        'query-result.csv',
        '*.csv|*.txt',
    );

    assert.deepEqual(emitted, []);
    assert.deepEqual(messages, ['文件已保存到 /tmp/query-result.csv']);
    delete globalThis.window;
    delete globalThis.ElementPlus;
});


test('CSV export preserves nested MongoDB values as JSON', async () => {
    let saved = null;
    const context = {
        displayColumns: ['id', 'profile'],
        displayRows: [['1', { name: 'Ada', tags: ['admin'] }]],
        closeExportMenu() {},
        getCellValue(row, _column, index) { return row[index]; },
        exportCellText: ResultArea.methods.exportCellText,
        resolveExportData: ResultArea.methods.resolveExportData,
        exportScope: 'page',
        canExportAll: false,
        async _saveFile(content, filename, fileTypes) {
            saved = { content, filename, fileTypes };
        },
    };

    await ResultArea.methods.exportCSV.call(context);

    assert.equal(saved.filename, 'query-result.csv');
    assert.match(saved.content, /"\{""name"":""Ada"",""tags"":\[""admin""\]\}"/);
    assert.doesNotMatch(saved.content, /\[object Object\]/);
});


test('SQL INSERT export is limited to relational providers', () => {
    const supports = ResultArea.computed.supportsSqlInsertExport;
    assert.equal(supports.call({ queryResult: { providerId: 'mysql' } }), true);
    assert.equal(supports.call({ queryResult: { providerId: 'postgresql' } }), true);
    assert.equal(supports.call({ queryResult: { providerId: 'sqlite' } }), true);
    assert.equal(supports.call({ queryResult: { providerId: 'mongodb' } }), false);
    assert.equal(supports.call({ queryResult: { providerId: 'redis' } }), false);
});


test('export all re-queries the backend and uses the full result', async () => {
    let saved = null;
    const requested = [];
    const messages = [];
    globalThis.ElementPlus = { ElMessage: { warning(m) { messages.push(m); }, error(m) { messages.push(m); } } };
    const context = {
        displayColumns: ['id', 'name'],
        displayRows: [[1, 'a']],
        exportScope: 'all',
        canExportAll: true,
        exportAll: { sourceId: 7, query: 'SELECT id, name FROM t' },
        exporting: false,
        dbService: {
            async exportQuery(query, sourceId) {
                requested.push({ query, sourceId });
                return { success: true, columns: ['id', 'name'], data: [[1, 'a'], [2, 'b'], [3, 'c']], truncated: true, max_rows: 3 };
            },
        },
        closeExportMenu() {},
        getCellValue(row, _column, index) { return row[index]; },
        exportCellText: ResultArea.methods.exportCellText,
        resolveExportData: ResultArea.methods.resolveExportData,
        async _saveFile(content, filename) { saved = { content, filename }; },
    };

    await ResultArea.methods.exportCSV.call(context);

    assert.deepEqual(requested, [{ query: 'SELECT id, name FROM t', sourceId: 7 }]);
    assert.equal(saved.content.split('\n').length, 4);
    assert.equal(context.exporting, false);
    assert.match(messages[0], /只导出前 3 行/);
    delete globalThis.ElementPlus;
});

test('export all failure does not write a file', async () => {
    let saved = false;
    const errors = [];
    globalThis.ElementPlus = { ElMessage: { warning() {}, error(m) { errors.push(m); } } };
    const context = {
        displayColumns: ['id'],
        displayRows: [[1]],
        exportScope: 'all',
        canExportAll: true,
        exportAll: { sourceId: 1, query: 'SELECT id FROM t' },
        dbService: { async exportQuery() { return { success: false, error: '只能导出只读查询的结果' }; } },
        closeExportMenu() {},
        resolveExportData: ResultArea.methods.resolveExportData,
        async _saveFile() { saved = true; },
    };

    await ResultArea.methods.exportJSON.call(context);

    assert.equal(saved, false);
    assert.match(errors[0], /只能导出只读查询的结果/);
    delete globalThis.ElementPlus;
});

test('export all is offered only when there are more rows than the current page', () => {
    const can = ResultArea.computed.canExportAll;
    const spec = { sourceId: 1, query: 'SELECT 1' };
    assert.equal(can.call({ exportAll: spec, exportTotal: 250, displayRows: new Array(100) }), true);
    assert.equal(can.call({ exportAll: spec, exportTotal: 100, displayRows: new Array(100) }), false);
    assert.equal(can.call({ exportAll: null, exportTotal: 250, displayRows: new Array(100) }), false);
    assert.equal(can.call({ exportAll: spec, exportTotal: null, displayRows: [] }), false);
});

test('full export follows the on-screen column order when names are unique', () => {
    const aligned = alignExportColumns(['name', 'id'], ['id', 'name'], [[1, 'a']]);
    assert.deepEqual(aligned, { cols: ['name', 'id'], rows: [['a', 1]] });

    const duplicated = alignExportColumns(['id', 'id'], ['id', 'id'], [[1, 2]]);
    assert.deepEqual(duplicated, { cols: ['id', 'id'], rows: [[1, 2]] });
});

test('base64 conversion handles files larger than the call stack limit', () => {
    const bytes = new Uint8Array(300000).map((_, i) => i % 256);
    const encoded = bytesToBase64(bytes);
    assert.equal(Buffer.from(encoded, 'base64').equals(Buffer.from(bytes)), true);
});
