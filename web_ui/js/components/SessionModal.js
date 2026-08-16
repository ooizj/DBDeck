export default {
    inject: ['dbService'],
    props: {
        show: { type: Boolean, default: false },
        sourceId: { type: Number, required: true },
        sourceName: { type: String, default: '' }
    },
    emits: ['close'],
    data() {
        return {
            sessions: [],
            loading: false,
            error: null,
            autoRefresh: false,
            refreshInterval: null
        };
    },
    watch: {
        show(val) {
            if (val) {
                this.loadSessions();
            } else {
                this.stopAutoRefresh();
            }
        }
    },
    beforeUnmount() {
        this.stopAutoRefresh();
    },
    methods: {
        async loadSessions() {
            this.loading = true;
            this.error = null;
            try {
                const result = await this.dbService.getSessions(this.sourceId);
                if (result.success) {
                    this.sessions = result.sessions || [];
                } else {
                    this.error = result.error || '加载失败';
                }
            } catch (e) {
                this.error = e.message || '加载失败';
            } finally {
                this.loading = false;
            }
        },
        async killSession(sessionId) {
            try { await ElementPlus.ElMessageBox.confirm(`确定要终止会话 ${sessionId} 吗？`, '确认', { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' }); } catch { return; }

            try {
                const result = await this.dbService.killSession(this.sourceId, sessionId);
                if (result.success) {
                    await this.loadSessions();
                } else {
                    ElementPlus.ElMessage.error(result.error || '终止失败');
                }
            } catch (e) {
                ElementPlus.ElMessage.error(e.message || '终止失败');
            }
        },
        toggleAutoRefresh() {
            this.autoRefresh = !this.autoRefresh;
            if (this.autoRefresh) {
                this.refreshInterval = setInterval(() => {
                    this.loadSessions();
                }, 3000);
            } else {
                this.stopAutoRefresh();
            }
        },
        stopAutoRefresh() {
            if (this.refreshInterval) {
                clearInterval(this.refreshInterval);
                this.refreshInterval = null;
            }
            this.autoRefresh = false;
        },
        formatTime(seconds) {
            if (!seconds) return '-';
            if (seconds < 60) return `${seconds}s`;
            if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
            return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
        },
        getStateClass(state) {
            if (!state) return '';
            const s = state.toLowerCase();
            if (s === 'active' || s === 'running') return 'state-active';
            if (s === 'idle' || s === 'sleeping') return 'state-idle';
            if (s === 'blocked' || s === 'waiting') return 'state-blocked';
            return '';
        }
    },
    template: `
        <el-dialog
            :model-value="show"
            @update:model-value="$emit('close')"
            width="900px"
            destroy-on-close
            append-to-body
        >
            <template #header>
                <div style="display: flex; align-items: center; justify-content: space-between; width: 100%; padding-right: 24px;">
                    <span style="font-size: 16px; font-weight: 600;">会话管理 - {{ sourceName }}</span>
                    <div>
                        <el-button :type="autoRefresh ? 'primary' : 'default'" size="small" @click="toggleAutoRefresh" title="自动刷新">🔄 自动</el-button>
                        <el-button size="small" @click="loadSessions" title="刷新">↻ 刷新</el-button>
                    </div>
                </div>
            </template>

            <div class="modal-body">
                <div v-if="error" class="error-message">{{ error }}</div>

                <div v-if="loading && !sessions.length" class="loading">
                    加载中...
                </div>

                <div v-else-if="!sessions.length" class="empty-state">
                    暂无活跃会话
                </div>

                <div v-else class="session-table-wrapper">
                    <table class="session-table">
                        <thead>
                            <tr>
                                <th>ID</th>
                                <th>用户</th>
                                <th>来源</th>
                                <th>数据库</th>
                                <th>状态</th>
                                <th>命令</th>
                                <th>运行时间</th>
                                <th>SQL</th>
                                <th>操作</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="session in sessions" :key="session.id">
                                <td class="session-id">{{ session.id }}</td>
                                <td>{{ session.user || '-' }}</td>
                                <td>{{ session.host || '-' }}</td>
                                <td>{{ session.db || '-' }}</td>
                                <td>
                                    <span class="state-badge" :class="getStateClass(session.state)">
                                        {{ session.state || session.command || '-' }}
                                    </span>
                                </td>
                                <td>{{ session.command || '-' }}</td>
                                <td>{{ formatTime(session.time) }}</td>
                                <td class="sql-cell" :title="session.info">
                                    {{ session.info || '-' }}
                                </td>
                                <td>
                                    <el-button type="danger" size="small" @click="killSession(session.id)" title="终止会话">终止</el-button>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <template #footer>
                <span style="float: left; color: var(--el-text-color-secondary); line-height: 32px;">共 {{ sessions.length }} 个会话</span>
                <el-button @click="$emit('close')">关闭</el-button>
            </template>
        </el-dialog>
    `
};
