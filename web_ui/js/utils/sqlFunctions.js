import { MYSQL_FUNCTIONS } from './mysqlFunctions.js';

const parseVersion = (version) => {
    const match = String(version || '').match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3] || 0)] : null;
};

const compareVersions = (a, b) => {
    for (let index = 0; index < 3; index += 1) {
        if (a[index] !== b[index]) return a[index] - b[index];
    }
    return 0;
};

const byVersion = new Map();

/**
 * 当前 MySQL 服务器版本（VERSION() 的返回值，如 `5.7.25-log`）可用的内置函数。
 * 版本未知时给出最新版本仍可用的函数；MariaDB 的函数集与 MySQL 不同，不提示。
 */
export const mysqlFunctionsForVersion = (version) => {
    const key = String(version || '');
    if (!byVersion.has(key)) {
        const current = parseVersion(key);
        const available = /mariadb/i.test(key) ? [] : MYSQL_FUNCTIONS.filter(([, , , since, until]) => (
            current
                ? compareVersions(current, parseVersion(since)) >= 0
                    && (!until || compareVersions(current, parseVersion(until)) < 0)
                : !until
        ));
        byVersion.set(key, available.map(([name, signatures, description, , , deprecated]) => ({
            name, signatures, description, deprecated: Boolean(deprecated),
        })));
    }
    return byVersion.get(key);
};
