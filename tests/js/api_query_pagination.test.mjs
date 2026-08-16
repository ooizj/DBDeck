import assert from 'node:assert/strict';
import test from 'node:test';

import { dbService } from '../../web_ui/js/api.js';


test('executeSql sends query pagination options to the API', async () => {
    const originalFetch = globalThis.fetch;
    let captured = null;
    globalThis.fetch = async (url, options) => {
        captured = { url, options };
        return {
            ok: true,
            json: async () => ({ success: true }),
        };
    };

    try {
        await dbService.executeSql('SELECT * FROM users', 9, { page: 2, pageSize: 50 });
    } finally {
        globalThis.fetch = originalFetch;
    }

    assert.equal(captured.url, '/api/execute-sql');
    assert.deepEqual(JSON.parse(captured.options.body), {
        query: 'SELECT * FROM users',
        source_id: 9,
        page: 2,
        page_size: 50,
    });
});
