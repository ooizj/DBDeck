import assert from 'node:assert/strict';
import test from 'node:test';

import ResultArea from '../../web_ui/js/components/ResultArea.js';


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
