import { t } from '../i18n/index.js';
import { createSqlCompletion } from '../utils/sqlCompletion.js';
import { quoteTableName } from '../utils/sqlHelpers.js';

const tableSql = table => quoteTableName(table.name, 'postgresql');

const sqlKeywords = [
    'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'LIKE', 'ILIKE',
    'BETWEEN', 'IS NULL', 'IS NOT NULL', 'ASC', 'DESC', 'USING', 'ORDER BY', 'GROUP BY',
    'LIMIT', 'OFFSET', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN',
    'FULL JOIN', 'CROSS JOIN', 'ON', 'AS', 'INSERT INTO', 'UPDATE',
    'DELETE', 'SET', 'VALUES', 'RETURNING', 'CREATE TABLE', 'ALTER TABLE',
    'DROP TABLE', 'INDEX', 'WITH', 'UNION', 'INTERSECT', 'EXCEPT',
    'DISTINCT', 'HAVING', 'WINDOW', 'OVER', 'PARTITION BY',
];

export default {
    id: 'postgresql',
    displayName: 'PostgreSQL',
    defaultPort: 5432,
    editorLanguage: 'mysql',
    capabilities: { ddl: true, migrate: false, explain: true, backup: false, hasSchema: true },
    childLabel: 'table',
    supportsCopyDDL: true,

    connFormFields: [
        { key: 'host', get label() { return t('field.host'); }, type: 'text', flex: 2, placeholder: 'localhost' },
        { key: 'port', get label() { return t('field.port'); }, type: 'number', flex: 1, placeholder: 5432 },
        { key: 'user', get label() { return t('field.user'); }, type: 'text', flex: 1 },
        { key: 'password', get label() { return t('field.password'); }, type: 'password', flex: 1 },
        { key: 'database', get label() { return t('field.database'); }, type: 'database-discover', flex: 1, get placeholder() { return t('field.example', { value: 'postgres' }); } },
    ],

    registerCompletion(monaco, { getCurrentTables, getModelText }) {
        return createSqlCompletion(monaco, { getCurrentTables, getModelText }, sqlKeywords);
    },

    buildSelectQuery(table) {
        if (!table.columns || table.columns.length === 0) {
            return `SELECT * FROM ${tableSql(table)};`;
        }
        const cols = table.columns.map(c => `"${c.name}"`).join(', ');
        return `SELECT ${cols} FROM ${tableSql(table)};`;
    },

    buildInsertQuery(table) {
        if (!table.columns || table.columns.length === 0) {
            return `INSERT INTO ${tableSql(table)} (...) VALUES (...);`;
        }
        const cols = table.columns.map(c => `"${c.name}"`).join(', ');
        const vals = table.columns.map(() => '?').join(', ');
        return `INSERT INTO ${tableSql(table)} (${cols}) VALUES (${vals});`;
    },

    buildPreviewQuery(table) {
        return `SELECT * FROM ${tableSql(table)} LIMIT 100;`;
    },
};
