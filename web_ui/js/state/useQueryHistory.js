const { ref, watch } = Vue;

export function useQueryHistory({ dbService, getEditor, getEditorMode, getActiveTab, showMessage, showConfirm, notify }) {
    const historyItems = ref([]);
    const historySearch = ref('');

    const loadHistory = async () => {
        try {
            const params = { limit: 100 };
            if (historySearch.value) params.search = historySearch.value;
            const res = await dbService.getHistory(params);
            if (res.success) historyItems.value = res.items;
        } catch (e) { console.error('Failed to load history', e); }
    };

    const selectHistoryItem = (item) => {
        const editor = getEditor();
        if (editor) {
            const query = item.query || '';
            const position = editor.getPosition();
            const range = {
                startLineNumber: position.lineNumber,
                startColumn: position.column,
                endLineNumber: position.lineNumber,
                endColumn: position.column,
            };
            editor.executeEdits('history-insert', [{
                range,
                text: (position.column > 1 ? '\n' : '') + query,
            }]);
            editor.focus();
        }
        const editorMode = getEditorMode();
        const activeTab = getActiveTab();
        if (editorMode) editorMode.value = 'sql';
        if (activeTab) activeTab.value = 'database';
    };

    const clearAllHistory = async () => {
        if (await showConfirm('确定要清空所有查询历史吗？')) {
            try {
                await dbService.clearHistory();
                historyItems.value = [];
                notify('历史已清空', 'success');
            } catch (e) { showMessage('清空失败: ' + e.message, '错误', 'error'); }
        }
    };

    // Setup watchers - call after all refs are available
    const setupWatchers = (activeTabRef) => {
        watch(activeTabRef, (tab) => { if (tab === 'history') loadHistory(); });
        watch(historySearch, () => { if (activeTabRef.value === 'history') loadHistory(); });
    };

    return {
        historyItems,
        historySearch,
        loadHistory,
        selectHistoryItem,
        clearAllHistory,
        setupWatchers,
    };
}
