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
            label: '数据库路径（相对项目根目录或绝对路径）',
            type: 'text',
            flex: 1,
            placeholder: '例如: data/my_db.sqlite',
            hint: '如果文件不存在，系统将自动尝试创建。',
        },
    ],
};
