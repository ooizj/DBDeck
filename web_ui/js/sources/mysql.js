import { createSqlCompletion } from '../utils/sqlCompletion.js';

const sqlKeywords = [
    'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'ORDER BY', 'GROUP BY',
    'LIMIT', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'ON',
    'AS', 'INSERT INTO', 'UPDATE', 'DELETE', 'SET', 'VALUES',
    'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'INDEX',
];

export default {
    id: 'mysql',
    displayName: 'MySQL',
    defaultPort: 3306,
    editorLanguage: 'mysql',
    capabilities: { ddl: true, migrate: true, explain: true, backup: true, hasSchema: true },
    childLabel: 'table',
    supportsCopyDDL: true,

    connFormFields: [
        { key: 'host', label: '主机', type: 'text', flex: 2, placeholder: 'localhost' },
        { key: 'port', label: '端口', type: 'number', flex: 1, placeholder: 3306 },
        { key: 'user', label: '用户', type: 'text', flex: 1 },
        { key: 'password', label: '密码', type: 'password', flex: 1 },
        { key: 'database', label: '数据库名称', type: 'database-discover', flex: 1, placeholder: '例如: test' },
    ],

    registerCompletion(monaco, { getCurrentTables, getModelText }) {
        return createSqlCompletion(monaco, { getCurrentTables, getModelText }, sqlKeywords);
    },

    buildSelectQuery(table) {
        if (!table.columns || table.columns.length === 0) {
            return `SELECT * FROM \`${table.name}\`;`;
        }
        const cols = table.columns.map(c => `\`${c.name}\``).join(', ');
        return `SELECT ${cols} FROM \`${table.name}\`;`;
    },

    buildInsertQuery(table) {
        if (!table.columns || table.columns.length === 0) {
            return `INSERT INTO \`${table.name}\` (...) VALUES (...);`;
        }
        const cols = table.columns.map(c => `\`${c.name}\``).join(', ');
        const vals = table.columns.map(() => '?').join(', ');
        return `INSERT INTO \`${table.name}\` (${cols}) VALUES (${vals});`;
    },

    buildPreviewQuery(table) {
        return `SELECT * FROM \`${table.name}\` LIMIT 100;`;
    },
};
