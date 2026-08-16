export function shouldLockSqlEditor(isSwitchingSource, currentSource) {
    return Boolean(isSwitchingSource || currentSource?.loading);
}

export function updateEditorReadOnly(editor, readOnly) {
    if (!editor) return;
    editor.updateOptions({
        readOnly: Boolean(readOnly),
        domReadOnly: Boolean(readOnly),
    });
}
