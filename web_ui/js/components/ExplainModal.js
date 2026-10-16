// 执行计划节点（递归）：一行显示操作与对象，下方缩进显示子节点；点击行展开该节点的全部指标
const PlanNode = {
    name: 'PlanNode',
    props: ['node', 'depth'],
    data() {
        return { showMetrics: false };
    },
    computed: {
        summaryMetrics() {
            return (this.node.metrics || []).filter(m => ['成本', '估算行数'].includes(m.key));
        },
        hasMetrics() {
            return (this.node.metrics || []).length > 0;
        },
    },
    template: `
        <div class="plan-node">
            <div :class="['plan-node-row', { clickable: hasMetrics, open: showMetrics }]" @click="hasMetrics && (showMetrics = !showMetrics)">
                <span class="plan-node-label">{{ node.label }}</span>
                <span v-if="node.detail" class="plan-node-detail">{{ node.detail }}</span>
                <span class="plan-node-summary">
                    <span v-for="m in summaryMetrics" :key="m.key">{{ m.key }} {{ m.value }}</span>
                </span>
            </div>
            <dl v-if="showMetrics" class="plan-node-metrics">
                <template v-for="m in node.metrics" :key="m.key">
                    <dt>{{ m.key }}</dt>
                    <dd>{{ m.value }}</dd>
                </template>
            </dl>
            <div v-if="node.children && node.children.length" class="plan-node-children">
                <plan-node v-for="(child, index) in node.children" :key="index" :node="child" :depth="depth + 1"></plan-node>
            </div>
        </div>
    `,
};

export default {
    components: { PlanNode },
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
            viewMode: 'tree',
        };
    },
    computed: {
        views() {
            if (!this.planData) return [];
            const views = [];
            if (this.planData.tree) views.push({ key: 'tree', label: '树形' });
            if (this.planData.table?.columns?.length) views.push({ key: 'table', label: '表格' });
            if (this.planData.raw !== null && this.planData.raw !== undefined) views.push({ key: 'raw', label: '原始' });
            return views;
        },
        treeHasMetrics() {
            const walk = node => Boolean(node) && ((node.metrics || []).length > 0 || (node.children || []).some(walk));
            return walk(this.planData?.tree);
        },
        rawText() {
            const raw = this.planData?.raw;
            return typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
        },
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

            // 超时兜底：无论后端是否阻塞，15 秒后一定结束 loading 并报错
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
                    this.viewMode = this.views[0]?.key || 'tree';
                } else {
                    this.error = (result && result.error) || '获取执行计划失败';
                }
            } catch (e) {
                this.error = e.message || '获取执行计划失败';
            } finally {
                this.loading = false;
            }
        },
        formatCell(value) {
            if (value === null || value === undefined) return '';
            return typeof value === 'object' ? JSON.stringify(value) : value;
        },
        formatMs(value) {
            return typeof value === 'number' ? `${value.toFixed(2)} ms` : value;
        },
    },
    template: `
        <el-dialog
            :model-value="show"
            @update:model-value="$emit('close')"
            title="执行计划"
            width="1000px"
            destroy-on-close
            append-to-body
            class="explain-dialog"
        >
            <div class="explain-body">
                <pre v-if="query" class="explain-query">{{ planData?.query || query }}</pre>

                <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" />

                <div v-if="loading" class="explain-loading">
                    <span class="spinner-small"></span>
                    正在分析执行计划…
                </div>

                <template v-else-if="planData">
                    <div class="explain-toolbar">
                        <el-radio-group v-model="viewMode" size="small">
                            <el-radio-button v-for="view in views" :key="view.key" :value="view.key">{{ view.label }}</el-radio-button>
                        </el-radio-group>
                        <span class="explain-meta">
                            <span v-if="planData.planning_time != null">规划耗时 {{ formatMs(planData.planning_time) }}</span>
                            <span v-if="viewMode === 'tree' && treeHasMetrics" class="muted">点击节点查看全部指标</span>
                        </span>
                    </div>

                    <div v-if="viewMode === 'tree' && planData.tree" class="explain-view plan-tree-view">
                        <plan-node :node="planData.tree" :depth="0"></plan-node>
                    </div>

                    <div v-else-if="viewMode === 'table'" class="explain-view plan-table-view">
                        <table class="plan-table">
                            <thead>
                                <tr><th v-for="col in planData.table.columns" :key="col">{{ col }}</th></tr>
                            </thead>
                            <tbody>
                                <tr v-for="(row, idx) in planData.table.rows" :key="idx">
                                    <td v-for="(cell, cellIdx) in row" :key="cellIdx" :class="{ 'plan-cell-long': String(formatCell(cell)).length > 40 }">{{ formatCell(cell) }}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    <pre v-else-if="viewMode === 'raw'" class="explain-view plan-raw-view">{{ rawText }}</pre>
                </template>
            </div>

            <template #footer>
                <el-button @click="$emit('close')">关闭</el-button>
                <el-button type="primary" @click="loadPlan" :loading="loading">重新分析</el-button>
            </template>
        </el-dialog>
    `
};
