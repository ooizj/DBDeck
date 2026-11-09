import { t } from '../i18n/index.js';
import { createSqlCompletion } from '../utils/sqlCompletion.js';
import { mysqlFunctionsForVersion } from '../utils/sqlFunctions.js';

export const sqlKeywords = [
    'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'LIKE', 'BETWEEN',
    'IS NULL', 'IS NOT NULL', 'ORDER BY', 'GROUP BY', 'HAVING', 'ASC', 'DESC',
    'LIMIT', 'OFFSET', 'DISTINCT', 'UNION', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN',
    'INNER JOIN', 'CROSS JOIN', 'ON', 'USING', 'AS', 'WITH',
    'INSERT INTO', 'REPLACE INTO', 'UPDATE', 'DELETE', 'SET', 'VALUES',
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
        { key: 'host', get label() { return t('field.host'); }, type: 'text', flex: 2, placeholder: 'localhost' },
        { key: 'port', get label() { return t('field.port'); }, type: 'number', flex: 1, placeholder: 3306 },
        { key: 'user', get label() { return t('field.user'); }, type: 'text', flex: 1 },
        { key: 'password', get label() { return t('field.password'); }, type: 'password', flex: 1 },
        { key: 'database', get label() { return t('field.database'); }, type: 'database-discover', flex: 1, get placeholder() { return t('field.example', { value: 'test' }); } },
    ],

    registerCompletion(monaco, ctx) {
        // 同一 MySQL 服务器上可以 `库.表` 跨库查询，补全时按需加载其他库的元数据
        return createSqlCompletion(monaco, {
            getCurrentTables: ctx.getCurrentTables,
            getModelText: ctx.getModelText,
            getCurrentDatabase: () => ctx.getCurrentSource?.()?.database || '',
            loadDatabases: ctx.loadDatabases,
            loadDatabaseTables: ctx.loadDatabaseTables,
            // 按服务器版本提示内置函数
            loadFunctions: ctx.loadServerVersion
                ? async () => mysqlFunctionsForVersion(await ctx.loadServerVersion())
                : undefined,
        }, sqlKeywords);
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
