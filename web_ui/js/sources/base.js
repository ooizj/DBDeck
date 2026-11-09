/**
 * SourceProvider 前端接口约定。
 *
 * 每个数据源类型实现：
 *   - id, displayName, defaultPort
 *   - editorLanguage             Monaco language id
 *   - capabilities { ddl, migrate, explain, backup, hasSchema }
 *   - connFormFields              连接表单字段定义（给 Modals.js）
 *   - registerCompletion(monaco, ctx)
 *       ctx: { getCurrentTables(), getCurrentSource(), getModelText(),
 *              loadDatabases(), loadDatabaseTables(database),     // 返回 Promise，用于跨库补全
 *              loadServerVersion() }                              // 返回 Promise<版本号>，用于按版本提示函数
 *   - buildSelectQuery(table)     "查看数据" / "Copy SELECT"
 *   - buildInsertQuery(table)
 *   - buildPreviewQuery(table)    点击节点时自动执行的 SQL
 *   - supportsCopyDDL             右键菜单是否显示 "Copy DDL"
 *   - childLabel                  树里子项的类型名（"table" / "collection"）
 */

import { t } from '../i18n/index.js';

export const defaults = {
    defaultPort: null,
    editorLanguage: 'plaintext',
    capabilities: { ddl: false, migrate: false, explain: false, backup: false, hasSchema: true },
    connFormFields: [],
    supportsCopyDDL: false,
    childLabel: 'item',
    registerCompletion() { /* no-op */ },
    buildSelectQuery(table) { return `SELECT * FROM \`${table.name}\` LIMIT 100;`; },
    buildInsertQuery(table) { return `INSERT INTO \`${table.name}\` (...) VALUES (...);`; },
    copyInsertLabel() { return t('provider.copyInsert'); },
    buildPreviewQuery(table) { return this.buildSelectQuery(table); },
};

export const sshTunnelFields = [
    {
        key: 'use_ssh_tunnel',
        get label() { return t('field.useSshTunnel'); },
        type: 'checkbox',
        get hint() { return t('field.useSshTunnelHint'); },
    },
    { key: 'ssh_host', get label() { return t('field.sshHost'); }, type: 'text', get placeholder() { return t('field.example', { value: 'jump.example.com' }); }, visibleWhen: { key: 'use_ssh_tunnel', value: true } },
    { key: 'ssh_port', get label() { return t('field.sshPort'); }, type: 'number', placeholder: 22, visibleWhen: { key: 'use_ssh_tunnel', value: true } },
    { key: 'ssh_user', get label() { return t('field.sshUser'); }, type: 'text', visibleWhen: { key: 'use_ssh_tunnel', value: true } },
    { key: 'ssh_password', get label() { return t('field.sshPassword'); }, type: 'password', visibleWhen: { key: 'use_ssh_tunnel', value: true } },
    {
        key: 'ssh_private_key',
        get label() { return t('field.sshPrivateKey'); },
        type: 'text',
        get placeholder() { return t('field.example', { value: '/Users/me/.ssh/id_rsa' }); },
        get hint() { return t('field.sshPrivateKeyHint'); },
        visibleWhen: { key: 'use_ssh_tunnel', value: true },
    },
    {
        key: 'ssh_private_key_passphrase',
        get label() { return t('field.sshPassphrase'); },
        type: 'password',
        visibleWhen: { key: 'use_ssh_tunnel', value: true },
    },
];
