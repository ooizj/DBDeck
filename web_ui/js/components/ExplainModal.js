export default {
    inject: ['dbService'],
    props: {
        show: { type: Boolean, default: false },
        sourceId: { type: Number, default: null },
        query: { type: String, default: '' }
    },
    emits: ['close'],
    data() {
        return {
            planData: null,
            loading: false,
            error: null,
            viewMode: 'tree', // tree, table, json
            selectedNode: null,
            zoom: 1
        };
    },
    watch: {
        show(val) {
            if (val && this.query) {
                this.loadPlan();
            }
        }
    },
    methods: {
        async loadPlan() {
            if (!this.query || !this.query.trim()) { this.error = '没有可分析的 SQL'; this.loading = false; return; }
            if (!this.sourceId) { this.error = '未选择数据源'; this.loading = false; return; }

            this.loading = true;
            this.error = null;
            this.planData = null;

            // 超时兜底：无论后端是否阻塞，15 秒后一定结束 loading 并报错，
            // 避免遮罩永久转圈、整页看起来"卡死"(#1)
            const timeout = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('分析超时（15 秒）。请检查数据库连接，或简化 SQL 后重试。')), 15000)
            );
            try {
                const result = await Promise.race([
                    this.dbService.getVisualPlan(this.sourceId, this.query),
                    timeout,
                ]);
                if (result && result.success) {
                    this.planData = result;
                } else {
                    this.error = (result && result.error) || '获取执行计划失败';
                }
            } catch (e) {
                this.error = e.message || '获取执行计划失败';
            } finally {
                this.loading = false;
            }
        },
        selectNode(node) {
            this.selectedNode = node;
        },
        getOperationIcon(type) {
            if (type === null || type === undefined || type === '') return '❓';
            const t = String(type).toLowerCase();
            if (t.includes('scan') || t.includes('seq')) return '📋';
            if (t.includes('index')) return '📇';
            if (t.includes('join')) return '🔗';
            if (t.includes('sort')) return '↕️';
            if (t.includes('filter')) return '🔍';
            if (t.includes('hash')) return '#️⃣';
            if (t.includes('merge')) return '🔀';
            return '⚡';
        },
        getCostClass(cost) {
            if (!cost) return '';
            if (cost < 100) return 'cost-low';
            if (cost < 1000) return 'cost-medium';
            return 'cost-high';
        },
        formatCost(cost) {
            if (!cost) return '0';
            if (cost < 1000) return cost.toFixed(1);
            if (cost < 1000000) return (cost / 1000).toFixed(1) + 'K';
            return (cost / 1000000).toFixed(1) + 'M';
        },
        zoomIn() {
            this.zoom = Math.min(this.zoom + 0.1, 2);
        },
        zoomOut() {
            this.zoom = Math.max(this.zoom - 0.1, 0.5);
        },
        resetZoom() {
            this.zoom = 1;
        }
    },
    template: `
        <el-dialog
            :model-value="show"
            @update:model-value="$emit('close')"
            title="执行计划分析"
            width="900px"
            :close-on-click-modal="true"
            destroy-on-close
            append-to-body
            class="explain-dialog"
        >
            <template #header>
                <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
                    <span style="font-size: 16px; font-weight: 600;">执行计划分析</span>
                    <div class="view-mode-tabs">
                        <el-button :type="viewMode === 'tree' ? 'primary' : 'default'" size="small" @click="viewMode = 'tree'">树形</el-button>
                        <el-button :type="viewMode === 'table' ? 'primary' : 'default'" size="small" @click="viewMode = 'table'">表格</el-button>
                        <el-button :type="viewMode === 'json' ? 'primary' : 'default'" size="small" @click="viewMode = 'json'">JSON</el-button>
                    </div>
                </div>
            </template>

            <div class="modal-body">
                <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" style="margin-bottom: 12px;" />

                <div v-if="loading" style="text-align: center; padding: 40px 0; color: var(--el-text-color-regular);">
                    <span class="spinner-small" style="display: inline-block; vertical-align: middle; margin-right: 8px;"></span>
                    分析执行计划中…（可点击遮罩或下方"关闭"随时退出）
                </div>

                <template v-else-if="planData">
                    <div class="plan-summary">
                        <div class="summary-item" v-if="planData.planning_time">
                            <span class="label">规划时间:</span>
                            <span class="value">{{ planData.planning_time?.toFixed(2) }} ms</span>
                        </div>
                        <div class="summary-item" v-if="planData.execution_time">
                            <span class="label">执行时间:</span>
                            <span class="value">{{ planData.execution_time?.toFixed(2) }} ms</span>
                        </div>
                        <div class="summary-item" v-if="planData.provider">
                            <span class="label">数据库:</span>
                            <span class="value">{{ planData.provider }}</span>
                        </div>
                    </div>

                    <div v-if="viewMode === 'tree'" class="plan-tree-container">
                        <div class="tree-toolbar">
                            <el-button size="small" @click="zoomOut" title="缩小">➖</el-button>
                            <span class="zoom-level">{{ Math.round(zoom * 100) }}%</span>
                            <el-button size="small" @click="zoomIn" title="放大">➕</el-button>
                            <el-button size="small" @click="resetZoom" title="重置">↺</el-button>
                        </div>
                        <div class="plan-tree" :style="{ transform: 'scale(' + zoom + ')' }">
                            <template v-if="planData.tree">
                                <div class="tree-node root-node">
                                    <div class="node-header" @click="selectNode(planData.tree)">
                                        <span class="node-icon">{{ getOperationIcon(planData.tree.type) }}</span>
                                        <span class="node-type">{{ planData.tree.type }}</span>
                                        <span class="node-table" v-if="planData.tree.table">{{ planData.tree.table }}</span>
                                        <span class="node-cost" :class="getCostClass(planData.tree.total_cost)">
                                            {{ formatCost(planData.tree.total_cost) }}
                                        </span>
                                        <span class="node-rows">{{ planData.tree.rows }} 行</span>
                                    </div>
                                    <div v-if="planData.tree.children && planData.tree.children.length" class="node-children">
                                        <div v-for="child in planData.tree.children" :key="child.type" class="child-node">
                                            <div class="node-header" @click="selectNode(child)">
                                                <span class="node-icon">{{ getOperationIcon(child.type) }}</span>
                                                <span class="node-type">{{ child.type }}</span>
                                                <span class="node-table" v-if="child.table || child.relation">{{ child.table || child.relation }}</span>
                                                <span class="node-cost" :class="getCostClass(child.total_cost)">
                                                    {{ formatCost(child.total_cost) }}
                                                </span>
                                                <span class="node-rows">{{ child.rows }} 行</span>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </template>

                            <template v-else-if="planData.nodes">
                                <div class="sqlite-plan">
                                    <div v-for="node in planData.nodes" :key="node.id" class="plan-row">
                                        <span class="row-id">{{ node.id }}</span>
                                        <span class="row-detail">{{ node.detail }}</span>
                                    </div>
                                </div>
                            </template>
                        </div>
                    </div>

                    <div v-else-if="viewMode === 'table'" class="plan-table-container">
                        <table v-if="planData.columns" class="plan-table">
                            <thead>
                                <tr>
                                    <th v-for="col in planData.columns" :key="col">{{ col }}</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="(row, idx) in planData.rows" :key="idx">
                                    <td v-for="(cell, cellIdx) in row" :key="cellIdx">{{ cell }}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    <div v-else-if="viewMode === 'json'" class="plan-json-container">
                        <pre>{{ JSON.stringify(planData.raw || planData, null, 2) }}</pre>
                    </div>

                    <div v-if="selectedNode" class="node-details">
                        <h4>节点详情</h4>
                        <div class="detail-grid">
                            <div v-for="(value, key) in selectedNode" :key="key" class="detail-item" v-if="key !== 'children'">
                                <span class="detail-key">{{ key }}:</span>
                                <span class="detail-value">{{ typeof value === 'object' ? JSON.stringify(value) : value }}</span>
                            </div>
                        </div>
                    </div>
                </template>
            </div>

            <template #footer>
                <el-button @click="$emit('close')">关闭</el-button>
                <el-button type="primary" @click="loadPlan" :loading="loading">重新分析</el-button>
            </template>
        </el-dialog>
    `
};
