import { t } from '../i18n/index.js';
export default {
    inject: ['dbService'],
    props: {
        show: { type: Boolean, default: false },
        sourceId: { type: Number, default: null },
        sourceType: { type: String, default: '' },
        tables: { type: Array, default: () => [] }
    },
    emits: ['close'],
    data() {
        return {
            table1: null,
            table2: null,
            compareResult: null,
            loading: false,
            error: null,
            viewMode: 'summary' // summary, details
        };
    },
    computed: {
        isMongoSource() {
            return this.sourceType === 'mongodb';
        },
        structureCompareRows() {
            const columns = this.compareResult?.columns;
            if (!columns) return [];
            const rows = [];
            (columns.only_in_table1 || []).forEach(col => rows.push({
                key: `left-${col.name}`,
                name: col.name,
                left: col,
                right: null,
                status: 'only-left',
                differences: []
            }));
            (columns.different || []).forEach(col => rows.push({
                key: `diff-${col.name}`,
                name: col.name,
                left: col.table1 || { name: col.name, type: col.table1_type },
                right: col.table2 || { name: col.name, type: col.table2_type },
                status: 'different',
                differences: col.differences || []
            }));
            (columns.identical || []).forEach(col => rows.push({
                key: `same-${col.name}`,
                name: col.name,
                left: col,
                right: col,
                status: 'same',
                differences: []
            }));
            (columns.only_in_table2 || []).forEach(col => rows.push({
                key: `right-${col.name}`,
                name: col.name,
                left: null,
                right: col,
                status: 'only-right',
                differences: []
            }));
            const rank = { 'different': 0, 'only-left': 1, 'only-right': 2, 'same': 3 };
            return rows.sort((a, b) => {
                const byRank = rank[a.status] - rank[b.status];
                if (byRank) return byRank;
                return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
            });
        }
    },
    watch: {
        show(val) {
            if (val) {
                this.reset();
            }
        },
        table1(val) {
            this.compareResult = null;
        }
    },
    methods: {
        reset() {
            this.table1 = null;
            this.table2 = null;
            this.compareResult = null;
            this.error = null;
        },
        async doCompare() {
            if (this.isMongoSource) {
                this.error = t('compare.unsupported', { db: 'MongoDB' });
                return;
            }
            if (!this.table1 || !this.table2) {
                this.error = t('compare.needTables');
                return;
            }

            this.loading = true;
            this.error = null;
            this.compareResult = null;

            try {
                const result = await this.dbService.compareTableStructure(this.sourceId, this.table1, this.table2);

                if (result.success) {
                    this.compareResult = result;
                } else {
                    this.error = result.error || t('compare.failed');
                }
            } catch (e) {
                this.error = e.message || t('compare.failed');
            } finally {
                this.loading = false;
            }
        },
        getDiffClass(diffCount) {
            if (diffCount === 0) return 'diff-ok';
            if (diffCount < 5) return 'diff-warning';
            return 'diff-error';
        },
        statusLabel(status) {
            const keys = {
                'same': 'compare.same',
                'different': 'compare.different',
                'only-left': 'compare.onlyTable1',
                'only-right': 'compare.onlyTable2'
            };
            return keys[status] ? t(keys[status]) : status;
        },
        columnType(col) {
            return col?.type || '-';
        },
        columnComment(col) {
            return (col?.comment || '').trim() || t('compare.noComment');
        },
        differenceText(row) {
            if (!row.differences?.length) return '';
            const property = (name) => ({ type: t('compare.propType'), nullable: t('compare.propNullable'), comment: t('compare.propComment') }[name] || name);
            const empty = t('compare.empty');
            return row.differences
                .map(diff => `${property(diff.property)}: ${diff.table1 || empty} → ${diff.table2 || empty}`)
                .join(t('compare.diffSeparator'));
        }
    },
    template: `
        <el-dialog
            :model-value="show"
            @update:model-value="$emit('close')"
            :title="$t('toolbar.compare')"
            width="960px"
            destroy-on-close
            append-to-body
        >
            <template #header>
                <span style="font-size: 16px; font-weight: 600;">{{ $t('toolbar.compare') }}</span>
            </template>

            <div class="modal-body">
                <el-alert v-if="isMongoSource" :title="$t('compare.unsupported', { db: 'MongoDB' })" type="warning" show-icon :closable="false" style="margin-bottom: 12px;" />
                <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" style="margin-bottom: 12px;" />

                <div class="compare-form">
                    <div class="form-row">
                        <div class="form-field">
                            <label>{{ $t('compare.table1') }}</label>
                            <el-select v-model="table1" :placeholder="$t('compare.pickTable')" filterable style="width: 100%;">
                                <el-option v-for="t in tables" :key="t" :value="t" :label="t" />
                            </el-select>
                        </div>

                        <div class="form-field">
                            <label>{{ $t('compare.table2') }}</label>
                            <el-select v-model="table2" :placeholder="$t('compare.pickTable')" filterable style="width: 100%;">
                                <el-option v-for="t in tables" :key="t" :value="t" :label="t" />
                            </el-select>
                        </div>
                    </div>

                    <el-button @click="doCompare" :loading="loading" :disabled="isMongoSource || !table1 || !table2">
                        {{ loading ? $t('compare.running') : $t('compare.start') }}
                    </el-button>
                </div>

                <template v-if="compareResult">
                    <div class="compare-summary">
                        <h4>{{ $t('compare.summary') }}</h4>
                        <div class="summary-grid">
                            <div class="summary-card" :class="getDiffClass(compareResult.summary.identical_count)">
                                <div class="card-value">{{ compareResult.summary.identical_count }}</div>
                                <div class="card-label">{{ $t('compare.same') }}</div>
                            </div>
                            <div class="summary-card" :class="getDiffClass(compareResult.summary.different_count)">
                                <div class="card-value">{{ compareResult.summary.different_count }}</div>
                                <div class="card-label">{{ $t('compare.different') }}</div>
                            </div>
                            <div class="summary-card diff-warning">
                                <div class="card-value">{{ compareResult.summary.only_in_table1_count }}</div>
                                <div class="card-label">{{ $t('compare.onlyTable1') }}</div>
                            </div>
                            <div class="summary-card diff-warning">
                                <div class="card-value">{{ compareResult.summary.only_in_table2_count }}</div>
                                <div class="card-label">{{ $t('compare.onlyTable2') }}</div>
                            </div>
                        </div>
                    </div>

                    <div class="compare-details compare-side-by-side">
                        <div class="compare-table-head">
                            <div>{{ compareResult.table1 || compareResult.source1?.table || $t('compare.table1') }}</div>
                            <div>{{ $t('compare.status') }}</div>
                            <div>{{ compareResult.table2 || compareResult.source2?.table || $t('compare.table2') }}</div>
                        </div>
                        <div v-for="row in structureCompareRows" :key="row.key" :class="['compare-row', row.status]">
                            <div class="compare-column-card">
                                <template v-if="row.left">
                                    <div class="compare-col-line" :title="row.left.name + '  ' + columnType(row.left) + '  ' + columnComment(row.left)">
                                        <span class="compare-col-name">{{ row.left.name }}</span>
                                        <span class="compare-col-type">{{ columnType(row.left) }}</span>
                                        <span class="compare-col-comment">{{ columnComment(row.left) }}</span>
                                    </div>
                                </template>
                                <span v-else class="compare-missing">{{ $t('compare.missingColumn') }}</span>
                            </div>
                            <div class="compare-status">
                                <span :class="['compare-status-pill', row.status]">{{ statusLabel(row.status) }}</span>
                                <small v-if="differenceText(row)">{{ differenceText(row) }}</small>
                            </div>
                            <div class="compare-column-card">
                                <template v-if="row.right">
                                    <div class="compare-col-line" :title="row.right.name + '  ' + columnType(row.right) + '  ' + columnComment(row.right)">
                                        <span class="compare-col-name">{{ row.right.name }}</span>
                                        <span class="compare-col-type">{{ columnType(row.right) }}</span>
                                        <span class="compare-col-comment">{{ columnComment(row.right) }}</span>
                                    </div>
                                </template>
                                <span v-else class="compare-missing">{{ $t('compare.missingColumn') }}</span>
                            </div>
                        </div>
                    </div>
                </template>
            </div>

            <template #footer>
                <el-button @click="$emit('close')">{{ $t('common.close') }}</el-button>
            </template>
        </el-dialog>
    `
};
