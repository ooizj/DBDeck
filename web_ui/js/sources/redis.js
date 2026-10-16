import { buildRedisSetCommand, formatRedisArgument } from '../utils/redisCommands.js';

const redisCommands = [
    'GET', 'MGET', 'SET', 'DEL', 'EXISTS', 'TYPE', 'TTL', 'PTTL',
    'HGETALL', 'HGET', 'HSET', 'LRANGE', 'LPUSH', 'RPUSH',
    'SMEMBERS', 'SADD', 'ZRANGE', 'ZADD', 'SCAN', 'KEYS', 'DBSIZE', 'INFO',
];

function keyType(table) {
    return table.columns?.find(c => c.name === 'type')?.type || 'unknown';
}

function quoteKey(key) {
    return formatRedisArgument(key);
}

export default {
    id: 'redis',
    displayName: 'Redis',
    defaultPort: 6379,
    editorLanguage: 'plaintext',
    capabilities: { ddl: false, migrate: false, explain: false, hasSchema: true },
    childLabel: 'key',
    supportsCopyDDL: false,

    connFormFields: [
        { key: 'host', label: '主机', type: 'text', flex: 2, placeholder: 'localhost' },
        { key: 'port', label: '端口', type: 'number', flex: 1, placeholder: 6379 },
        { key: 'user', label: '用户名', type: 'text', flex: 1, placeholder: '可选' },
        { key: 'password', label: '密码', type: 'password', flex: 1 },
        {
            key: 'database',
            label: '数据库编号',
            type: 'database-discover',
            flex: 1,
            placeholder: '0',
            hint: 'Redis DB index，例如 0、1、2。',
        },
    ],

    registerCompletion(monaco, { getCurrentTables }) {
        return {
            triggerCharacters: [' ', ':'],
            provideCompletionItems: (model, position) => {
                const word = model.getWordUntilPosition(position);
                const range = {
                    startLineNumber: position.lineNumber,
                    endLineNumber: position.lineNumber,
                    startColumn: word.startColumn,
                    endColumn: word.endColumn,
                };
                const suggestions = [];
                redisCommands.forEach(cmd => suggestions.push({
                    label: cmd,
                    kind: monaco.languages.CompletionItemKind.Keyword,
                    insertText: cmd,
                    range,
                }));
                getCurrentTables().forEach(key => suggestions.push({
                    label: key.name,
                    kind: monaco.languages.CompletionItemKind.Value,
                    insertText: quoteKey(key.name),
                    detail: `Redis ${keyType(key)}`,
                    range,
                }));
                return { suggestions };
            },
        };
    },

    buildSelectQuery(table) {
        const key = quoteKey(table.name);
        const type = keyType(table);
        if (type === 'string') return `GET ${key}`;
        if (type === 'hash') return `HGETALL ${key}`;
        if (type === 'list') return `LRANGE ${key} 0 -1`;
        if (type === 'set') return `SMEMBERS ${key}`;
        if (type === 'zset') return `ZRANGE ${key} 0 -1 WITHSCORES`;
        if (type === 'stream') return `XRANGE ${key} - +`;
        return `TYPE ${key}`;
    },

    copyInsertLabel(table) {
        const type = keyType(table);
        if (type === 'hash') return '复制 HSET';
        if (type === 'list') return '复制 RPUSH';
        if (type === 'set') return '复制 SADD';
        if (type === 'zset') return '复制 ZADD';
        return '复制 SET';
    },

    buildInsertQuery(table, currentValue) {
        const key = quoteKey(table.name);
        const type = keyType(table);
        if (type === 'hash') return `HSET ${key} field value`;
        if (type === 'list') return `RPUSH ${key} value`;
        if (type === 'set') return `SADD ${key} value`;
        if (type === 'zset') return `ZADD ${key} 1 value`;
        return currentValue === undefined
            ? `SET ${key} value`
            : buildRedisSetCommand(table.name, currentValue);
    },

    buildPreviewQuery(table) {
        return this.buildSelectQuery(table);
    },
};
