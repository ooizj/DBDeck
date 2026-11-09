import { t } from '../i18n/index.js';
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
        { key: 'host', get label() { return t('field.host'); }, type: 'text', flex: 2, placeholder: 'localhost' },
        { key: 'port', get label() { return t('field.port'); }, type: 'number', flex: 1, placeholder: 27017 },
        { key: 'user', get label() { return t('field.user'); }, type: 'text', flex: 1 },
        { key: 'password', get label() { return t('field.password'); }, type: 'password', flex: 1 },
        { key: 'database', get label() { return t('field.database'); }, type: 'database-discover', flex: 1, get placeholder() { return t('field.example', { value: 'test' }); } },
        { key: 'auth_source', get label() { return t('field.authSource'); }, type: 'text', flex: 1, get placeholder() { return t('field.example', { value: 'admin' }); } },
        {
            key: 'direct_connection',
            get label() { return t('field.directConnection'); },
            type: 'checkbox',
            get hint() { return t('field.directConnectionHint'); },
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
        return t('provider.copyCommand', { command: 'insertOne' });
    },

    buildInsertQuery(table, document = { field1: 'value1' }) {
        return buildMongoInsertOneCommand(table.name, document);
    },

    buildPreviewQuery(table) {
        return `${mongoCollectionExpression(table.name)}.find({})`;
    },
};
