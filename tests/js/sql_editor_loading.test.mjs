import assert from 'node:assert/strict';
import test from 'node:test';

import {
    shouldLockSqlEditor,
    updateEditorReadOnly,
} from '../../web_ui/js/utils/editorState.js';
import SqlEditor from '../../web_ui/js/components/SqlEditor.js';


test('SQL editor is locked while the selected database is loading', () => {
    assert.equal(shouldLockSqlEditor(false, { loading: true }), true);
    assert.equal(shouldLockSqlEditor(true, { loading: false }), true);
    assert.equal(shouldLockSqlEditor(false, { loading: false }), false);
});

test('changing editor read-only state preserves the current SQL', () => {
    const updates = [];
    const editor = {
        value: 'SELECT * FROM orders;',
        getValue() { return this.value; },
        updateOptions(options) { updates.push(options); },
    };

    updateEditorReadOnly(editor, true);
    updateEditorReadOnly(editor, false);

    assert.equal(editor.getValue(), 'SELECT * FROM orders;');
    assert.deepEqual(updates, [
        { readOnly: true, domReadOnly: true },
        { readOnly: false, domReadOnly: false },
    ]);
});

test('SQL editor disables actions and explains the loading lock', () => {
    assert.ok(SqlEditor.props.includes('disabled'));
    assert.match(SqlEditor.template, /:disabled="disabled \|\| !currentSource"/);
    assert.match(SqlEditor.template, /数据库加载中，SQL 暂时只读/);
});
