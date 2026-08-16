import mysqlProvider from './mysql.js';

export default {
    ...mysqlProvider,
    id: 'sqlite',
    displayName: 'SQLite',
    defaultPort: null,
    editorLanguage: 'mysql',
    capabilities: { ddl: true, migrate: true, explain: true, backup: true, hasSchema: true },
    supportsCopyDDL: true,

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
