import { buildMongoInsertOneCommand, mongoCollectionExpression } from '../utils/mongoCommands.js';

const mongoMethods = [
    'getCollection', 'find', 'count', 'insertOne', 'updateOne', 'updateMany',
    'deleteOne', 'deleteMany', 'drop', 'aggregate', 'distinct',
];

export default {
    id: 'mongodb',
    displayName: 'MongoDB',
    defaultPort: 27017,
    editorLanguage: 'javascript',
    capabilities: { ddl: false, migrate: false, explain: false, hasSchema: true },
    childLabel: 'collection',
    supportsCopyDDL: false,

    connFormFields: [
        { key: 'host', label: '主机', type: 'text', flex: 2, placeholder: 'localhost' },
        { key: 'port', label: '端口', type: 'number', flex: 1, placeholder: 27017 },
        { key: 'user', label: '用户', type: 'text', flex: 1 },
        { key: 'password', label: '密码', type: 'password', flex: 1 },
        { key: 'database', label: '数据库名称', type: 'database-discover', flex: 1, placeholder: '例如: test' },
        { key: 'auth_source', label: '认证源 (authSource)', type: 'text', flex: 1, placeholder: '例如: admin' },
        {
            key: 'direct_connection',
            label: '直接连接 (Direct Connection)',
            type: 'checkbox',
            hint: '开启后将跳过副本集发现。如果你在 Docker 外连接容器内的副本集且报错 internal hostnames，请勾选此项。',
        },
    ],

    registerCompletion(monaco, { getCurrentTables }) {
        return {
            triggerCharacters: ['.', ' ', '"', "'"],
            provideCompletionItems: (model, position) => {
                const word = model.getWordUntilPosition(position);
                const range = {
                    startLineNumber: position.lineNumber,
                    endLineNumber: position.lineNumber,
                    startColumn: word.startColumn,
                    endColumn: word.endColumn,
                };
                const suggestions = [];
                const collections = getCurrentTables();
                const lineContent = model.getLineContent(position.lineNumber);
                const textBeforeCursor = lineContent.substring(0, position.column - 1);

                const dbDotRegex = /(?:^|[^a-zA-Z0-9_$])db\.[a-zA-Z0-9_$]*$/;
                if (textBeforeCursor.includes('getCollection(') || dbDotRegex.test(textBeforeCursor)) {
                    collections.forEach(c => suggestions.push({
                        label: c.name,
                        kind: monaco.languages.CompletionItemKind.Class,
                        insertText: c.name,
                        detail: 'Collection',
                        range,
                    }));
                }
                mongoMethods.forEach(m => suggestions.push({
                    label: m,
                    kind: monaco.languages.CompletionItemKind.Method,
                    insertText: m,
                    range,
                }));
                suggestions.push({
                    label: 'db',
                    kind: monaco.languages.CompletionItemKind.Variable,
                    insertText: 'db',
                    range,
                });
                return { suggestions };
            },
        };
    },

    buildSelectQuery(table) {
        return `${mongoCollectionExpression(table.name)}.find({})`;
    },

    copyInsertLabel() {
        return 'Copy insertOne';
    },

    buildInsertQuery(table, document = { field1: 'value1' }) {
        return buildMongoInsertOneCommand(table.name, document);
    },

    buildPreviewQuery(table) {
        return `${mongoCollectionExpression(table.name)}.find({})`;
    },
};
