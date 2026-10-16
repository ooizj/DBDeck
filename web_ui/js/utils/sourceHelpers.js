/**
 * 数据源连接配置的纯辅助函数（从 app.js 抽出）。
 * defaultSourceConfig：新建连接时的默认字段；sourcePayload：把树节点归一化为保存用的配置对象。
 */
import { getProvider } from '../sources/registry.js?v=7features-20260610';

export function defaultSourceConfig() {
    return {
        name: '',
        type: 'mysql',
        host: 'localhost',
        port: 3306,
        user: 'root',
        password: '',
        database: '',
        direct_connection: true,
        auth_source: '',
        use_ssh_tunnel: false,
        ssh_host: '',
        ssh_port: 22,
        ssh_user: '',
        ssh_password: '',
        ssh_private_key: '',
        ssh_private_key_passphrase: '',
        group_name: '',
    };
}

export function sourcePayload(source, overrides = {}) {
    return {
        name: source.name,
        type: source.db_type || source.type || 'mysql',
        host: source.host || 'localhost',
        port: source.port || (getProvider(source.db_type || source.type || 'mysql').defaultPort || 3306),
        user: source.user || (source.db_type === 'redis' ? '' : 'root'),
        password: source.password || '',
        database: source.database || '',
        direct_connection: source.direct_connection !== undefined ? source.direct_connection : true,
        auth_source: source.auth_source || '',
        use_ssh_tunnel: !!source.use_ssh_tunnel,
        ssh_host: source.ssh_host || '',
        ssh_port: source.ssh_port || 22,
        ssh_user: source.ssh_user || '',
        ssh_password: source.ssh_password || '',
        ssh_private_key: source.ssh_private_key || '',
        ssh_private_key_passphrase: source.ssh_private_key_passphrase || '',
        group_name: source.group_name || '',
        ...overrides,
    };
}
