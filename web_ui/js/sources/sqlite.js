import { t } from '../i18n/index.js';
import mysqlProvider, { sqlKeywords } from './mysql.js';
import { createSqlCompletion } from '../utils/sqlCompletion.js';

export default {
    ...mysqlProvider,
    id: 'sqlite',
    displayName: 'SQLite',
    defaultPort: null,
    editorLanguage: 'mysql',
    capabilities: { ddl: true, migrate: true, explain: true, backup: true, hasSchema: true },
    supportsCopyDDL: true,

    // 不沿用 MySQL 的跨库与内置函数补全：SQLite 没有这些元数据，函数集也不同
    registerCompletion(monaco, { getCurrentTables, getModelText }) {
        return createSqlCompletion(monaco, { getCurrentTables, getModelText }, sqlKeywords);
    },

    connFormFields: [
        {
            key: 'database',
            get label() { return t('field.sqlitePath'); },
            type: 'text',
            flex: 1,
            get placeholder() { return t('field.example', { value: '/Users/me/data/my_db.sqlite' }); },
            get hint() { return t('field.sqlitePathHint'); },
        },
    ],
};
