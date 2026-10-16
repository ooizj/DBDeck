export const fetchApi = async (path, options = {}) => {
    const response = await fetch(`/api${path}`, { 
        ...options, 
        headers: { 
            'Content-Type': 'application/json', 
            ...options.headers 
        } 
    });
    if (!response.ok) {
        let errorData;
        try {
            errorData = await response.json();
        } catch (_) {
            try {
                errorData = { detail: await response.text() };
            } catch (__) {
                errorData = { detail: response.statusText };
            }
        }
        const errMsg = errorData?.detail || errorData?.error || errorData?.message || response.statusText || '请求失败';
        const err = new Error(errMsg);
        err.status = response.status;
        err.detail = errMsg;
        throw err;
    }
    return response.json();
};

export const dbService = {
    getTree: () => fetchApi('/tree'),
    testConnection: (data) => fetchApi('/sources/test', { method: 'POST', body: JSON.stringify(data) }),
    listDatabases: (data) => fetchApi('/sources/list-databases', { method: 'POST', body: JSON.stringify(data) }),
    saveSource: (data, id = null) => {
        const method = id ? 'PUT' : 'POST';
        const url = id ? `/sources/${id}` : '/sources';
        return fetchApi(url, { method, body: JSON.stringify(data) });
    },
    deleteSource: (id) => fetchApi(`/sources/${id}`, { method: 'DELETE' }),
    disconnectSource: (id) => fetchApi(`/sources/${id}/disconnect`, { method: 'POST' }),
    executeSql: (query, sourceId, options = {}) => fetchApi('/execute-sql', {
        method: 'POST', 
        body: JSON.stringify({
            query,
            source_id: sourceId,
            page: options.page ?? null,
            page_size: options.pageSize ?? 100,
        })
    }),
    exportQuery: (query, sourceId) => fetchApi('/export-query', {
        method: 'POST',
        body: JSON.stringify({ query, source_id: sourceId }),
    }),
    getMetadata: (sourceId, options = {}) => {
        const params = new URLSearchParams({ source_id: sourceId });
        if (options.keyPattern) params.set('key_pattern', options.keyPattern);
        return fetchApi(`/metadata?${params.toString()}`);
    },
    getDDL: (tableName, sourceId) => {
        const params = new URLSearchParams({ table_name: tableName, source_id: sourceId });
        return fetchApi(`/metadata/ddl?${params.toString()}`);
    },
    migrate: (data) => fetchApi('/migrate', { method: 'POST', body: JSON.stringify(data) }),
    getScript: (sourceId) => fetchApi(`/scripts/${sourceId}`),
    saveScript: (sourceId, content) => fetchApi(`/scripts/${sourceId}`, { 
        method: 'POST', 
        body: JSON.stringify({ content }) 
    }),
    clearChat: (sessionId = null) => fetchApi('/clear-chat', {
        method: 'POST',
        body: JSON.stringify({ session_id: sessionId })
    }),
    getConfig: () => fetchApi('/config'),
    saveConfig: (settings) => fetchApi('/config', { 
        method: 'POST', 
        body: JSON.stringify({ settings }) 
    }),
    exportConfig: () => fetchApi('/export-config'),
    importConfig: (data) => fetchApi('/import-config', {
        method: 'POST',
        body: JSON.stringify(data)
    }),
    importDbeaverConfig: async (file) => {
        const buffer = await file.arrayBuffer();
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        }
        return fetchApi('/import-dbeaver-config', {
            method: 'POST',
            body: JSON.stringify({
                filename: file.name,
                content_base64: btoa(binary),
            })
        });
    },
    getHistory: (params = {}) => {
        const qs = new URLSearchParams(params).toString();
        return fetchApi(`/history?${qs}`);
    },
    clearHistory: (sourceId = null) => {
        const qs = sourceId ? `?source_id=${sourceId}` : '';
        return fetchApi(`/history${qs}`, { method: 'DELETE' });
    },
    importFile: (file, sourceId, tableName, mode) => {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('source_id', sourceId);
        formData.append('table_name', tableName);
        formData.append('mode', mode);
        return fetch('/api/import', {
            method: 'POST',
            body: formData,
        }).then(r => {
            if (!r.ok) return r.json().then(d => { throw new Error(d.detail || d.error || 'Import failed'); });
            return r.json();
        });
    },
    // ========== 数据编辑功能 ==========
    editData: (sourceId, table, operation, data, where = null) => fetchApi('/data/edit', {
        method: 'POST',
        body: JSON.stringify({ source_id: sourceId, table, operation, data, where })
    }),
    batchEditData: (sourceId, table, operations) => fetchApi('/data/batch-edit', {
        method: 'POST',
        body: JSON.stringify({ source_id: sourceId, table, operations })
    }),
    exportData: (sourceId, table, format = 'csv', where = null, limit = null) => fetchApi('/data/export', {
        method: 'POST',
        body: JSON.stringify({ source_id: sourceId, table, format, where, limit })
    }),
    backupDatabase: (sourceId, tables = null, includeStructure = true, includeData = true) => fetchApi('/data/backup', {
        method: 'POST',
        body: JSON.stringify({ source_id: sourceId, tables, include_structure: includeStructure, include_data: includeData })
    }),
    getTableColumns: (sourceId, table) => fetchApi(`/data/columns?source_id=${sourceId}&table=${encodeURIComponent(table)}`),
    getPrimaryKey: (sourceId, table) => fetchApi(`/data/primary-key?source_id=${sourceId}&table=${encodeURIComponent(table)}`),
    // ========== 连接分组与收藏 ==========
    toggleFavorite: (sourceId) => fetchApi(`/sources/${sourceId}/toggle-favorite`, { method: 'POST' }),
    setSourceGroup: (sourceId, name) => fetchApi(`/sources/${sourceId}/group`, { method: 'PUT', body: JSON.stringify({ name }) }),
    renameGroup: (groupId, name) => fetchApi(`/source-groups/${groupId}`, { method: 'PUT', body: JSON.stringify({ name }) }),
    ungroup: (groupId) => fetchApi(`/source-groups/${groupId}`, { method: 'DELETE' }),
    // ========== 会话管理功能 ==========
    getSessions: (sourceId) => fetchApi(`/sessions?source_id=${sourceId}`),
    killSession: (sourceId, sessionId) => fetchApi(`/sessions/kill?source_id=${sourceId}&session_id=${sessionId}`, { method: 'POST' }),
    // ========== 执行计划功能 ==========
    getVisualPlan: (sourceId, query) => {
        const params = new URLSearchParams({ source_id: sourceId, query });
        return fetchApi(`/explain/visualize?${params}`);
    },
    // ========== 结构比较功能 ==========
    compareTableStructure: (sourceId, table1, table2) => {
        const params = new URLSearchParams({ source_id: sourceId, table1, table2 });
        return fetchApi(`/compare/structure?${params}`);
    },
};
