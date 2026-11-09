import { t } from '../i18n/index.js';

// 执行计划节点（递归）：一行显示操作与对象，下方缩进显示子节点；点击行展开该节点的全部指标
const PlanNode = {
    name: 'PlanNode',
    props: ['node', 'depth'],
    data() {
        return { showMetrics: false };
    },
    computed: {
        summaryMetrics() {
            // 后端用 id 标记摘要指标（key 是随界面语言变化的显示名）
            return (this.node.metrics || []).filter(m => ['cost', 'rows'].includes(m.id));
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
            if (this.planData.tree) views.push({ key: 'tree', label: t('explain.viewTree') });
            if (this.planData.table?.columns?.length) views.push({ key: 'table', label: t('explain.viewTable') });
            if (this.planData.raw !== null && this.planData.raw !== undefined) views.push({ key: 'raw', label: t('explain.viewRaw') });
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
            if (!this.query || !this.query.trim()) { this.error = t('explain.needSql'); this.loading = false; return; }
            if (!this.sourceId) { this.error = t('common.selectSourceFirst'); this.loading = false; return; }

            this.loading = true;
            this.error = null;
            this.planData = null;

            // 超时兜底：无论后端是否阻塞，15 秒后一定结束 loading 并报错
            const timeout = new Promise((_, reject) =>
                setTimeout(() => reject(new Error(t('explain.timeout'))), 15000)
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
                    this.error = (result && result.error) || t('explain.failed');
                }
            } catch (e) {
                this.error = e.message || t('explain.failed');
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
            :title="$t('editor.explain')"
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
                    {{ $t('explain.loading') }}
                </div>

                <template v-else-if="planData">
                    <div class="explain-toolbar">
                        <el-radio-group v-model="viewMode" size="small">
                            <el-radio-button v-for="view in views" :key="view.key" :value="view.key">{{ view.label }}</el-radio-button>
                        </el-radio-group>
                        <span class="explain-meta">
                            <span v-if="planData.planning_time != null">{{ $t('explain.planningTime', { time: formatMs(planData.planning_time) }) }}</span>
                            <span v-if="viewMode === 'tree' && treeHasMetrics" class="muted">{{ $t('explain.clickNode') }}</span>
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
                <el-button @click="$emit('close')">{{ $t('common.close') }}</el-button>
                <el-button type="primary" @click="loadPlan" :loading="loading">{{ $t('explain.rerun') }}</el-button>
            </template>
        </el-dialog>
    `
};
