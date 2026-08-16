export default {
    props: ['items', 'search'],
    emits: ['update:search', 'select', 'clear'],
    methods: {
        formatTime(ts) {
            if (!ts) return '';
            const d = new Date(ts);
            const pad = n => String(n).padStart(2, '0');
            return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        },
        truncate(query, len = 80) {
            if (!query) return '';
            const oneLine = query.replace(/\n/g, ' ').trim();
            return oneLine.length > len ? oneLine.slice(0, len) + '...' : oneLine;
        },
        statusClass(status) {
            return status === 'error' ? 'history-error' : 'history-success';
        },
    },
    template: `
        <div class="history-panel">
            <div style="padding: 8px; border-bottom: 1px solid var(--el-border-color-lighter); display: flex; gap: 6px; align-items: center;">
                <el-input
                    :model-value="search"
                    @update:model-value="(v) => $emit('update:search', v)"
                    placeholder="搜索查询历史..."
                    size="small"
                    clearable
                />
                <el-button size="small" @click="$emit('clear')" title="清空历史">清空</el-button>
            </div>
            <div class="history-list">
                <div v-if="!items.length" class="history-empty">暂无查询历史</div>
                <div v-for="item in items" :key="item.id" class="history-item" @click="$emit('select', item)">
                    <div class="history-item-header">
                        <span :class="statusClass(item.status)">{{ item.status === 'error' ? '✕' : '✓' }}</span>
                        <span class="history-time">{{ formatTime(item.created_at) }}</span>
                        <span v-if="item.source_name" class="history-source">{{ item.source_name }}</span>
                        <span v-if="item.duration_ms" class="history-duration">{{ item.duration_ms.toFixed(0) }}ms</span>
                        <span v-if="item.row_count" class="history-rows">{{ item.row_count }} rows</span>
                    </div>
                    <div class="history-query">{{ truncate(item.query) }}</div>
                </div>
            </div>
        </div>
    `
};
