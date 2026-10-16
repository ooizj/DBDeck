/**
 * SourceProvider 前端接口约定。
 *
 * 每个数据源类型实现：
 *   - id, displayName, defaultPort
 *   - editorLanguage             Monaco language id
 *   - capabilities { ddl, migrate, explain, backup, hasSchema }
 *   - connFormFields              连接表单字段定义（给 Modals.js）
 *   - registerCompletion(monaco, ctx)
 *       ctx: { getCurrentTables(), getCurrentSource(), getModelText() }
 *   - buildSelectQuery(table)     "查看数据" / "Copy SELECT"
 *   - buildInsertQuery(table)
 *   - buildPreviewQuery(table)    点击节点时自动执行的 SQL
 *   - supportsCopyDDL             右键菜单是否显示 "Copy DDL"
 *   - childLabel                  树里子项的类型名（"table" / "collection"）
 */

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
    copyInsertLabel() { return '复制 INSERT'; },
    buildPreviewQuery(table) { return this.buildSelectQuery(table); },
};

export const sshTunnelFields = [
    {
        key: 'use_ssh_tunnel',
        label: '使用 SSH 通道',
        type: 'checkbox',
        hint: '开启后会先连接 SSH 服务器，再通过本地隧道访问目标服务。',
    },
    { key: 'ssh_host', label: 'SSH 主机', type: 'text', placeholder: '例如: jump.example.com', visibleWhen: { key: 'use_ssh_tunnel', value: true } },
    { key: 'ssh_port', label: 'SSH 端口', type: 'number', placeholder: 22, visibleWhen: { key: 'use_ssh_tunnel', value: true } },
    { key: 'ssh_user', label: 'SSH 用户', type: 'text', visibleWhen: { key: 'use_ssh_tunnel', value: true } },
    { key: 'ssh_password', label: 'SSH 密码', type: 'password', visibleWhen: { key: 'use_ssh_tunnel', value: true } },
    {
        key: 'ssh_private_key',
        label: 'SSH 私钥路径',
        type: 'text',
        placeholder: '例如: /Users/me/.ssh/id_rsa',
        hint: '可选。填写本机私钥文件路径；如果使用密码登录可以留空。',
        visibleWhen: { key: 'use_ssh_tunnel', value: true },
    },
    {
        key: 'ssh_private_key_passphrase',
        label: '私钥口令',
        type: 'password',
        visibleWhen: { key: 'use_ssh_tunnel', value: true },
    },
];
