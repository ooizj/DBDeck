import assert from 'node:assert/strict';
import test from 'node:test';

import BackupModal from '../../web_ui/js/components/BackupModal.js';


test('desktop backup download uses the native save dialog', async () => {
    const calls = [];
    globalThis.window = {
        pywebview: {
            api: {
                async save_file(filename, content, fileTypes) {
                    calls.push({ filename, content, fileTypes });
                    return { success: true, path: `/tmp/${filename}` };
                },
            },
        },
    };
    globalThis.document = {
        createElement() {
            throw new Error('Blob download fallback opened instead of native save');
        },
    };
    const context = {
        backupResult: { content: 'CREATE TABLE users (id INTEGER);' },
        sourceName: 'local-db',
        savedPath: '',
    };

    await BackupModal.methods.downloadBackup.call(context);

    assert.equal(calls.length, 1);
    assert.match(calls[0].filename, /^local-db_\d{4}-\d{2}-\d{2}\.sql$/);
    assert.equal(calls[0].content, 'CREATE TABLE users (id INTEGER);');
    assert.equal(calls[0].fileTypes, 'sql|txt');
    assert.equal(context.savedPath, `/tmp/${calls[0].filename}`);
    delete globalThis.window;
    delete globalThis.document;
});
