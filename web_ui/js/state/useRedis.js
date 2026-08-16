const { ref, reactive } = Vue;

export function useRedis({ dbService, getCurrentSource, getTree, notify, showMessage, showConfirm, loadMetadata, getProvider }) {
    const redisKeyPattern = ref('*');
    const redisToolbarLoading = ref(false);
    const selectedRedisKeyName = ref('');
    const redisKeyEditor = reactive({
        mode: 'empty',
        key: '',
        originalKey: '',
        type: 'string',
        ttl: '-1',
        value: '',
        format: 'text',
        loading: false,
        saving: false,
        error: '',
    });

    const resetRedisKeyEditor = () => {
        selectedRedisKeyName.value = '';
        Object.assign(redisKeyEditor, {
            mode: 'empty',
            key: '',
            originalKey: '',
            type: 'string',
            ttl: '-1',
            value: '',
            format: 'text',
            loading: false,
            saving: false,
            error: '',
        });
    };

    const resetRedisNavigator = (source = null) => {
        if (source) {
            source.redisKeyPattern = undefined;
        }
        redisKeyPattern.value = '*';
        redisToolbarLoading.value = false;
        resetRedisKeyEditor();
    };

    const redisColumnValue = (table, name) => {
        const item = table?.columns?.find(c => c.name === name);
        return item?.type ?? '';
    };

    const quoteRedisArg = (value) => JSON.stringify(String(value ?? ''));

    const redisResultToText = (type, result) => {
        const rows = result.data || [];
        if (type === 'string') {
            return rows[0]?.[1] ?? '';
        }
        if (type === 'hash') {
            const obj = {};
            rows.forEach(row => { obj[row[0]] = row[1]; });
            return JSON.stringify(obj, null, 2);
        }
        if (type === 'zset') {
            return JSON.stringify(rows.map(row => ({
                member: row[0],
                score: Number(row[1]),
            })), null, 2);
        }
        if (type === 'stream') {
            return JSON.stringify(rows.map(row => ({
                id: row[0],
                fields: row[1] || {},
            })), null, 2);
        }
        const values = rows.map(row => row[1] ?? row[0]);
        return JSON.stringify(values, null, 2);
    };

    const parseRedisJsonValue = (type, value) => {
        try {
            return { ok: true, value: JSON.parse(value || (type === 'hash' ? '{}' : '[]')) };
        } catch (e) {
            return { ok: false, error: `${type} 类型的值必须是合法 JSON: ${e.message}` };
        }
    };

    const redisHashEntries = (value) => {
        if (Array.isArray(value)) {
            return value.map((item) => {
                if (Array.isArray(item)) return [item[0], item[1]];
                return [item.field ?? item.key ?? item.name, item.value];
            });
        }
        if (value && typeof value === 'object') return Object.entries(value);
        return null;
    };

    const redisArrayEntries = (value) => Array.isArray(value) ? value : null;

    const redisZSetEntries = (value) => {
        if (Array.isArray(value)) {
            return value.map((item) => {
                if (Array.isArray(item)) return { member: item[0], score: item[1] };
                return { member: item.member ?? item.value, score: item.score };
            });
        }
        if (value && typeof value === 'object') {
            return Object.entries(value).map(([member, score]) => ({ member, score }));
        }
        return null;
    };

    const redisStreamEntries = (value) => {
        if (!Array.isArray(value)) return null;
        return value.map((item) => ({
            id: item.id || '*',
            fields: item.fields || item.value || {},
        }));
    };

    const buildRedisWriteCommands = (type, keyName, rawValue) => {
        if (type === 'string') return [`SET ${quoteRedisArg(keyName)} ${quoteRedisArg(rawValue)}`];

        const parsed = parseRedisJsonValue(type, rawValue);
        if (!parsed.ok) return { error: parsed.error };

        const commands = [`DEL ${quoteRedisArg(keyName)}`];
        if (type === 'hash') {
            const entries = redisHashEntries(parsed.value);
            if (!entries) return { error: 'Hash 值必须是对象，或由 field/value 组成的数组' };
            if (!entries.length) return { error: 'Redis 不支持空 Hash key；请至少保留一个 field，或直接删除 key' };
            if (entries.some(([field]) => field === undefined || field === null || String(field) === '')) {
                return { error: 'Hash field 不能为空' };
            }
            commands.push(`HSET ${quoteRedisArg(keyName)} ${entries.flatMap(([field, value]) => [quoteRedisArg(field), quoteRedisArg(value)]).join(' ')}`);
            return commands;
        }
        if (type === 'list') {
            const entries = redisArrayEntries(parsed.value);
            if (!entries) return { error: 'List 值必须是数组' };
            if (!entries.length) return { error: 'Redis 不支持空 List key；请至少保留一个元素，或直接删除 key' };
            commands.push(`RPUSH ${quoteRedisArg(keyName)} ${entries.map(quoteRedisArg).join(' ')}`);
            return commands;
        }
        if (type === 'set') {
            const entries = redisArrayEntries(parsed.value);
            if (!entries) return { error: 'Set 值必须是数组' };
            if (!entries.length) return { error: 'Redis 不支持空 Set key；请至少保留一个成员，或直接删除 key' };
            commands.push(`SADD ${quoteRedisArg(keyName)} ${entries.map(quoteRedisArg).join(' ')}`);
            return commands;
        }
        if (type === 'zset') {
            const entries = redisZSetEntries(parsed.value);
            if (!entries) return { error: 'ZSet 值必须是数组或对象' };
            if (!entries.length) return { error: 'Redis 不支持空 ZSet key；请至少保留一个成员，或直接删除 key' };
            const parts = [];
            for (const item of entries) {
                if (item.member === undefined || item.member === null || String(item.member) === '') {
                    return { error: 'ZSet member 不能为空' };
                }
                const score = Number(item.score);
                if (!Number.isFinite(score)) return { error: `ZSet member "${item.member}" 的 score 必须是数字` };
                parts.push(String(score), quoteRedisArg(item.member));
            }
            commands.push(`ZADD ${quoteRedisArg(keyName)} ${parts.join(' ')}`);
            return commands;
        }
        if (type === 'stream') {
            const entries = redisStreamEntries(parsed.value);
            if (!entries) return { error: 'Stream 值必须是数组' };
            if (!entries.length) return { error: 'Redis 不支持空 Stream key；请至少保留一条消息，或直接删除 key' };
            for (const item of entries) {
                if (!item.fields || typeof item.fields !== 'object' || Array.isArray(item.fields)) {
                    return { error: 'Stream 每条记录必须包含 fields 对象' };
                }
                const fieldEntries = Object.entries(item.fields);
                if (!fieldEntries.length) return { error: 'Stream 记录的 fields 不能为空' };
                commands.push(`XADD ${quoteRedisArg(keyName)} ${quoteRedisArg(item.id || '*')} ${fieldEntries.flatMap(([field, value]) => [quoteRedisArg(field), quoteRedisArg(value)]).join(' ')}`);
            }
            return commands;
        }
        return { error: `暂不支持保存 ${type} 类型` };
    };

    const normalizeRedisTtl = (value) => {
        const text = String(value ?? '').trim();
        if (text === '') return -1;
        if (!/^-?\d+$/.test(text)) return null;
        const ttl = parseInt(text, 10);
        return ttl < -1 ? null : ttl;
    };

    const findCurrentTreeSource = () => {
        const currentSource = getCurrentSource();
        if (!currentSource) return null;
        const tree = getTree();
        return tree.find(s => s.type === 'source' && s.id === currentSource.id) || currentSource;
    };

    const addRedisKey = (isRedisSource) => {
        if (!isRedisSource) return;
        selectedRedisKeyName.value = '';
        Object.assign(redisKeyEditor, {
            mode: 'new',
            key: '',
            originalKey: '',
            type: 'string',
            ttl: '-1',
            value: '',
            format: 'text',
            loading: false,
            saving: false,
            error: '',
        });
    };

    const loadRedisKey = async (table) => {
        const source = findCurrentTreeSource();
        if (!source || source.db_type !== 'redis' || !table?.name) return;
        const keyName = table.name;
        const keyType = redisColumnValue(table, 'type') || 'string';
        selectedRedisKeyName.value = keyName;
        Object.assign(redisKeyEditor, {
            mode: 'existing',
            key: keyName,
            originalKey: keyName,
            type: keyType,
            ttl: redisColumnValue(table, 'ttl') === 'persistent' ? '-1' : String(redisColumnValue(table, 'ttl')).replace(/s$/, '') || '-1',
            value: '',
            format: keyType === 'string' ? 'text' : 'json',
            loading: true,
            saving: false,
            error: '',
        });
        try {
            const provider = getProvider(source.db_type);
            const data = await dbService.executeSql(provider.buildPreviewQuery(table), source.id);
            const currentSource = getCurrentSource();
            if (currentSource?.id !== source.id || selectedRedisKeyName.value !== keyName) return;
            if (data.success === false) {
                redisKeyEditor.error = data.error || '读取 Redis key 失败';
                return;
            }
            redisKeyEditor.value = redisResultToText(keyType, data);
        } catch (e) {
            redisKeyEditor.error = e.detail || e.message || String(e);
        } finally {
            if (selectedRedisKeyName.value === keyName) redisKeyEditor.loading = false;
        }
    };

    const saveRedisKey = async () => {
        const source = findCurrentTreeSource();
        if (!source || source.db_type !== 'redis') return;
        const keyName = redisKeyEditor.key.trim();
        if (!keyName) {
            notify('请输入 Redis key 名称', 'warning');
            return;
        }
        const ttl = normalizeRedisTtl(redisKeyEditor.ttl);
        if (ttl === null) {
            notify('TTL 必须是 -1 或非负整数', 'warning');
            return;
        }
        const commands = buildRedisWriteCommands(redisKeyEditor.type, keyName, redisKeyEditor.value);
        if (commands.error) {
            notify(commands.error, 'warning');
            return;
        }
        if (ttl >= 0) commands.push(`EXPIRE ${quoteRedisArg(keyName)} ${ttl}`);
        if (redisKeyEditor.mode === 'existing' && redisKeyEditor.originalKey && redisKeyEditor.originalKey !== keyName) {
            commands.push(`DEL ${quoteRedisArg(redisKeyEditor.originalKey)}`);
        }
        redisKeyEditor.saving = true;
        redisKeyEditor.error = '';
        try {
            const data = await dbService.executeSql(commands.join('\n'), source.id);
            if (data.success === false) {
                redisKeyEditor.error = data.error || '保存 Redis key 失败';
                return;
            }
            notify('Redis key 已保存', 'success');
            redisKeyEditor.mode = 'existing';
            redisKeyEditor.originalKey = keyName;
            selectedRedisKeyName.value = keyName;
            await loadMetadata(source, { keyPattern: redisKeyPattern.value || '*' });
        } catch (e) {
            redisKeyEditor.error = e.detail || e.message || String(e);
        } finally {
            redisKeyEditor.saving = false;
        }
    };

    const refreshRedisKey = async () => {
        const source = findCurrentTreeSource();
        if (!source || !redisKeyEditor.originalKey) return;
        const table = (source.children || []).find(item => item.name === redisKeyEditor.originalKey) || {
            name: redisKeyEditor.originalKey,
            type: 'key',
            columns: [
                { name: 'type', type: redisKeyEditor.type },
                { name: 'ttl', type: redisKeyEditor.ttl === '-1' ? 'persistent' : `${redisKeyEditor.ttl}s` },
            ],
        };
        await loadRedisKey(table);
    };

    const deleteRedisKey = async () => {
        const source = findCurrentTreeSource();
        const keyName = redisKeyEditor.originalKey || redisKeyEditor.key;
        if (!source || !keyName) return;
        if (!await showConfirm(`确定要删除 Redis key "${keyName}" 吗？`)) return;
        redisKeyEditor.saving = true;
        try {
            const data = await dbService.executeSql(`DEL ${quoteRedisArg(keyName)}`, source.id);
            if (data.success === false) {
                redisKeyEditor.error = data.error || '删除 Redis key 失败';
                return;
            }
            notify('Redis key 已删除', 'success');
            resetRedisKeyEditor();
            await loadMetadata(source, { keyPattern: redisKeyPattern.value || '*' });
        } catch (e) {
            redisKeyEditor.error = e.detail || e.message || String(e);
        } finally {
            redisKeyEditor.saving = false;
        }
    };

    const searchRedisKeys = async (expandedIdsRef) => {
        const source = findCurrentTreeSource();
        if (!source || source.db_type !== 'redis') return;
        redisToolbarLoading.value = true;
        try {
            expandedIdsRef.value = [source.id];
            await loadMetadata(source, { keyPattern: redisKeyPattern.value || '*' });
            notify(`已按 ${redisKeyPattern.value || '*'} 搜索 Redis key`, 'success');
        } finally {
            redisToolbarLoading.value = false;
        }
    };

    const resetRedisKeySearch = async (expandedIdsRef) => {
        redisKeyPattern.value = '*';
        await searchRedisKeys(expandedIdsRef);
    };

    return {
        redisKeyPattern,
        redisToolbarLoading,
        selectedRedisKeyName,
        redisKeyEditor,
        resetRedisKeyEditor,
        resetRedisNavigator,
        redisColumnValue,
        quoteRedisArg,
        redisResultToText,
        parseRedisJsonValue,
        redisHashEntries,
        redisArrayEntries,
        redisZSetEntries,
        redisStreamEntries,
        buildRedisWriteCommands,
        normalizeRedisTtl,
        findCurrentTreeSource,
        addRedisKey,
        loadRedisKey,
        saveRedisKey,
        refreshRedisKey,
        deleteRedisKey,
        searchRedisKeys,
        resetRedisKeySearch,
    };
}
