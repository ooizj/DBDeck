export function formatRedisArgument(value) {
    const raw = typeof value === 'object' && value !== null
        ? JSON.stringify(value)
        : String(value ?? '');
    const text = raw.replace(/^\0+/, '');
    if (/^[A-Za-z0-9_:.@/+\-]+$/.test(text)) return text;
    return JSON.stringify(text);
}

export function buildRedisSetCommand(key, value) {
    return `SET ${formatRedisArgument(key)} ${formatRedisArgument(value)}`;
}
