import { defaults, sshTunnelFields } from './base.js?v=7features-20260610';
import mysqlProvider from './mysql.js';
import postgresqlProvider from './postgresql.js';
import sqliteProvider from './sqlite.js';
import mongodbProvider from './mongodb.js';
import redisProvider from './redis.js';

const providers = {};

function register(p) {
    const provider = { ...defaults, ...p };
    const hasTcpEndpoint = Boolean(provider.defaultPort);
    const alreadyHasSshFields = (provider.connFormFields || []).some(field => field.key === 'use_ssh_tunnel');
    const supportsSshTunnel = provider.supportsSshTunnel !== false && hasTcpEndpoint;
    if (supportsSshTunnel && !alreadyHasSshFields) {
        provider.connFormFields = [...(provider.connFormFields || []), ...sshTunnelFields];
    }
    providers[p.id] = provider;
}

register(mysqlProvider);
register(postgresqlProvider);
register(sqliteProvider);
register(mongodbProvider);
register(redisProvider);

export function getProvider(type) {
    return providers[type] || providers.mysql;
}

export function listProviders() {
    return Object.values(providers);
}
