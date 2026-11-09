/**
 * 全表搜索：在选定（或全部）库的表里按关键字搜索数据。
 * 先向后端要搜索计划（每张表的候选字段），再逐表并发搜索，可随时停止。
 */
import { bytesToBase64, saveFile, timestampedFilename } from '../utils/saveFile.js';
import { t } from '../i18n/index.js';

const CONCURRENCY = 3;
const DETAIL_PAGE_SIZE = 100;
const TABLE_PREVIEW_LIMIT = 300;
// "按表"视图每张表最多渲染的行数，避免不限行数时一次渲染过多 DOM；全部数据可通过导出查看
const GROUP_VIEW_ROW_LIMIT = 200;
const detailHeaders = () => [
    t('search.colDatabase'), t('search.colTable'), t('search.colRecordId'),
    t('search.colColumn'), t('search.colComment'), t('search.colValue'),
];

const COLUMN_TYPE_OPTIONS = [
    { value: 'string', labelKey: 'search.typeString' },
    { value: 'number', labelKey: 'search.typeNumber' },
    { value: 'datetime', labelKey: 'search.typeDatetime' },
];

const MATCH_MODE_OPTIONS = [
    { value: 'contains', labelKey: 'search.modeContains' },
    { value: 'equals', labelKey: 'search.modeEquals' },
    { value: 'prefix', labelKey: 'search.modePrefix' },
];

const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

const cellText = (value) => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
};

/** 把各表的命中结果展开成明细：一个命中字段一行。 */
export function buildDetailRows(hits) {
    const rows = [];
    for (const hit of hits) {
        hit.rows.forEach((row, rowIndex) => {
            for (const column of hit.matched[rowIndex] || []) {
                rows.push({
                    key: `${hit.database}.${hit.table}#${rowIndex}#${column}`,
                    database: hit.database,
                    table: hit.table,
                    recordId: hit.record_ids?.[rowIndex] ?? '',
                    column,
                    comment: hit.column_comments?.[column] || '',
                    value: row[hit.columns.indexOf(column)],
                });
            }
        });
    }
    return rows;
}

function detailRecord(row) {
    return [row.database, row.table, row.recordId, row.column, row.comment, cellText(row.value)];
}

/** 明细 CSV；带 BOM，Excel 直接打开中文不乱码。 */
export function buildSearchCsv(detailRows) {
    const quote = (text) => `"${String(text).replace(/"/g, '""')}"`;
    const lines = [detailHeaders(), ...detailRows.map(detailRecord)].map(cells => cells.map(quote).join(','));
    return '\ufeff' + lines.join('\n');
}

/** Excel 工作表名：去掉非法字符、限制 31 个字符并去重。 */
export function sheetName(name, used) {
    const base = String(name).replace(/[\[\]:*?/\\]/g, '_').slice(0, 31) || 'Sheet';
    let candidate = base;
    for (let i = 2; used.has(candidate.toLowerCase()); i += 1) {
        const suffix = `~${i}`;
        candidate = base.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(candidate.toLowerCase());
    return candidate;
}

/** XLSX 内容：第一个工作表是明细，之后每张命中的表一个工作表（完整行，命中字段在前面标出）。 */
export function buildSearchSheets(hits, detailRows, { multiDatabase = false } = {}) {
    const used = new Set();
    const sheets = [{ name: sheetName(t('search.detailSheet'), used), header: detailHeaders(), rows: detailRows.map(detailRecord) }];
    for (const hit of hits) {
        sheets.push({
            name: sheetName(multiDatabase ? `${hit.database}.${hit.table}` : hit.table, used),
            header: [t('search.matchedColumns'), ...hit.columns],
            rows: hit.rows.map((row, i) => [(hit.matched[i] || []).join(', '), ...row.map(cellText)]),
        });
    }
    return sheets;
}

export default {
    inject: ['dbService'],
    props: {
        show: { type: Boolean, default: false },
        sourceId: { type: Number, default: null },
        sourceType: { type: String, default: '' },
        sourceName: { type: String, default: '' },
    },
    emits: ['close', 'copy'],
    data() {
        return {
            columnTypeOptions: COLUMN_TYPE_OPTIONS,
            matchModeOptions: MATCH_MODE_OPTIONS,
            databaseOptions: [],
            currentDatabase: '',
            tablePreview: { loading: false, tables: [], total: 0, error: '' },
            tablePreviewTimer: null,
            form: {
                keyword: '',
                matchMode: 'contains',
                databases: [],
                tableInclude: '',
                tableExclude: '',
                columnTypes: COLUMN_TYPE_OPTIONS.map(o => o.value),
                columnName: '',
                where: '',
                limit: 50,
                unlimited: false,
            },
            running: false,
            runToken: 0,
            error: '',
            warnings: [],
            keywordInfo: null,
            progress: { done: 0, total: 0, tableCount: 0 },
            hits: [],
            failures: [],
            expanded: {},
            searchedOnce: false,
            viewMode: 'detail',
            detailPage: 1,
            showFailures: false,
        };
    },
    computed: {
        isSqlite() {
            return this.sourceType === 'sqlite';
        },
        databaseLabel() {
            return this.sourceType === 'postgresql' ? t('search.schema') : t('search.colDatabase');
        },
        databasePlaceholder() {
            return this.sourceType === 'postgresql' ? t('search.allSchemas') : t('search.allDatabases');
        },
        progressPercent() {
            if (!this.progress.total) return this.running ? 0 : 100;
            return Math.round((this.progress.done / this.progress.total) * 100);
        },
        keywordTags() {
            const info = this.keywordInfo;
            if (!info) return [];
            const tags = [t('search.tagText', { text: info.text })];
            if (info.number !== null && info.number !== undefined) tags.push(t('search.tagNumber', { value: info.number }));
            if (info.date) tags.push(t('search.tagDate', { start: info.date.start, end: info.date.end || t('search.onwards') }));
            if (info.time) tags.push(t('search.tagTime', { start: info.time.start, end: info.time.end || '23:59:59' }));
            return tags;
        },
        multiDatabase() {
            return new Set(this.hits.map(h => h.database)).size > 1;
        },
        detailRows() {
            return buildDetailRows(this.hits);
        },
        detailPageRows() {
            const start = (this.detailPage - 1) * DETAIL_PAGE_SIZE;
            return this.detailRows.slice(start, start + DETAIL_PAGE_SIZE);
        },
        detailPageSize() {
            return DETAIL_PAGE_SIZE;
        },
        hitRowCount() {
            return this.hits.reduce((sum, hit) => sum + hit.rows.length, 0);
        },
        statusText() {
            if (!this.searchedOnce && !this.running) return '';
            const { done, total, tableCount } = this.progress;
            const parts = [t(this.running ? 'search.progressRunning' : 'search.progressDone', { done, total })];
            if (tableCount > total) parts.push(t('search.noSearchableColumns', { count: tableCount - total }));
            parts.push(t('search.hitSummary', { tables: this.hits.length, rows: this.hitRowCount, cells: this.detailRows.length }));
            return parts.join(t('search.partSeparator'));
        },
        previewLabel() {
            const p = this.tablePreview;
            if (p.loading) return t('result.counting');
            if (p.error) return t('search.previewFailed');
            const filtered = this.form.tableInclude.trim() || this.form.tableExclude.trim();
            return filtered
                ? t('search.previewFiltered', { count: p.tables.length, total: p.total })
                : t('search.previewAll', { total: p.total });
        },
        previewTables() {
            return this.tablePreview.tables.slice(0, TABLE_PREVIEW_LIMIT);
        },
    },
    watch: {
        show: {
            immediate: true,
            handler(val) {
                if (val) this.init();
                else this.stop();
            },
        },
        'form.databases'() {
            this.scheduleTablePreview();
        },
        'form.tableInclude'() {
            this.scheduleTablePreview();
        },
        'form.tableExclude'() {
            this.scheduleTablePreview();
        },
    },
    beforeUnmount() {
        this.stop();
        clearTimeout(this.tablePreviewTimer);
    },
    methods: {
        async init() {
            this.resetResults();
            this.error = '';
            this.databaseOptions = [];
            this.form.databases = [];
            if (!this.sourceId) return;
            try {
                const res = await this.dbService.getTableSearchDatabases(this.sourceId);
                if (!res.success) {
                    this.error = res.error || t('editor.databasesFailed');
                    return;
                }
                this.currentDatabase = res.current || '';
                this.databaseOptions = res.databases || [];
                // 默认只搜当前库；清空即搜索全部库
                if (!this.isSqlite && this.currentDatabase) this.form.databases = [this.currentDatabase];
                this.refreshTablePreview();
            } catch (e) {
                this.error = e.message || t('editor.databasesFailed');
            }
            this.$nextTick(() => this.$refs.keywordInput?.focus?.());
        },
        scopePayload() {
            return {
                source_id: this.sourceId,
                databases: this.form.databases.length ? this.form.databases : null,
                table_include: this.form.tableInclude.trim(),
                table_exclude: this.form.tableExclude.trim(),
            };
        },
        scheduleTablePreview() {
            clearTimeout(this.tablePreviewTimer);
            this.tablePreviewTimer = setTimeout(() => this.refreshTablePreview(), 300);
        },
        async refreshTablePreview() {
            if (!this.sourceId) return;
            const payload = this.scopePayload();
            const key = JSON.stringify(payload);
            this.tablePreview = { ...this.tablePreview, loading: true, error: '', key };
            try {
                const res = await this.dbService.listTableSearchTables(payload);
                if (this.tablePreview.key !== key) return;
                this.tablePreview = res.success
                    ? { loading: false, tables: res.tables || [], total: res.total || 0, error: '', key }
                    : { loading: false, tables: [], total: 0, error: res.error || t('common.loadFailed'), key };
            } catch (e) {
                if (this.tablePreview.key === key) {
                    this.tablePreview = { loading: false, tables: [], total: 0, error: e.message || t('common.loadFailed'), key };
                }
            }
        },
        resetResults() {
            this.hits = [];
            this.failures = [];
            this.warnings = [];
            this.keywordInfo = null;
            this.expanded = {};
            this.progress = { done: 0, total: 0, tableCount: 0 };
            this.searchedOnce = false;
            this.detailPage = 1;
            this.showFailures = false;
        },
        async startSearch() {
            if (this.running) return;
            if (!this.form.keyword.trim()) {
                this.error = t('search.keywordRequired');
                return;
            }
            if (!this.form.columnTypes.length) {
                this.error = t('search.typeRequired');
                return;
            }
            this.error = '';
            this.resetResults();
            const token = ++this.runToken;
            this.running = true;
            const criteria = {
                source_id: this.sourceId,
                keyword: this.form.keyword.trim(),
                column_types: this.form.columnTypes,
                column_name: this.form.columnName.trim(),
                match_mode: this.form.matchMode,
                where: this.form.where.trim(),
            };
            const limit = this.form.unlimited ? -1 : this.form.limit;
            try {
                const plan = await this.dbService.planTableSearch({ ...criteria, ...this.scopePayload() });
                if (token !== this.runToken) return;
                if (!plan.success) {
                    this.error = plan.error || t('search.planFailed');
                    return;
                }
                this.searchedOnce = true;
                this.keywordInfo = plan.keyword;
                this.warnings = plan.warnings || [];
                const queue = (plan.targets || []).slice();
                this.progress = { done: 0, total: queue.length, tableCount: (plan.table_count || 0) - (plan.skipped_by_filter || []).length };
                const worker = async () => {
                    while (queue.length && token === this.runToken) {
                        const target = queue.shift();
                        await this.searchOne(target, { ...criteria, limit }, token);
                    }
                };
                await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
            } catch (e) {
                if (token === this.runToken) this.error = e.message || t('search.failed');
            } finally {
                if (token === this.runToken) this.running = false;
            }
        },
        async searchOne(target, criteria, token) {
            let res;
            try {
                res = await this.dbService.searchTable({ ...criteria, database: target.database, table: target.table });
            } catch (e) {
                res = { success: false, error: e.message || String(e) };
            }
            if (token !== this.runToken) return;
            this.progress.done += 1;
            if (!res.success) {
                this.failures.push({ database: target.database, table: target.table, error: res.error || t('search.failed') });
                return;
            }
            if (!res.rows?.length) return;
            const matchedColumns = [...new Set(res.matched.flat())];
            this.hits.push({ ...res, key: `${res.database}.${res.table}`, matchedColumns });
            this.hits.sort((a, b) => byName(a.key, b.key));
            if (this.hits.length <= 3) this.expanded[`${res.database}.${res.table}`] = true;
        },
        stop() {
            this.runToken += 1;
            this.running = false;
        },
        toggle(hit) {
            this.expanded[hit.key] = !this.expanded[hit.key];
        },
        isMatched(hit, rowIndex, column) {
            return (hit.matched[rowIndex] || []).includes(column);
        },
        formatCell(value) {
            if (value === null || value === undefined) return 'NULL';
            if (typeof value === 'object') return JSON.stringify(value);
            return String(value);
        },
        // 把匹配内容按关键字（含日期的其他写法）切成片段，用于高亮（不使用 v-html）
        highlight(value) {
            const text = this.formatCell(value);
            const info = this.keywordInfo;
            const needles = [...new Set(info?.text_variants || (info?.text ? [info.text] : []))]
                .filter(Boolean).map(n => n.toLowerCase());
            if (!needles.length || value === null || value === undefined) return [{ text, hit: false }];
            const lower = text.toLowerCase();
            const parts = [];
            let from = 0;
            while (from < text.length) {
                let best = -1;
                let bestLength = 0;
                for (const needle of needles) {
                    const index = lower.indexOf(needle, from);
                    if (index !== -1 && (best === -1 || index < best || (index === best && needle.length > bestLength))) {
                        best = index;
                        bestLength = needle.length;
                    }
                }
                if (best === -1) break;
                if (best > from) parts.push({ text: text.slice(from, best), hit: false });
                parts.push({ text: text.slice(best, best + bestLength), hit: true });
                from = best + bestLength;
            }
            if (from < text.length) parts.push({ text: text.slice(from), hit: false });
            return parts.length ? parts : [{ text, hit: false }];
        },
        hitCountLabel(hit) {
            return t('history.rows', { count: hit.has_more ? `${hit.rows.length}+` : hit.rows.length });
        },
        groupRows(hit) {
            return hit.rows.slice(0, GROUP_VIEW_ROW_LIMIT);
        },
        groupRowsHidden(hit) {
            return Math.max(0, hit.rows.length - GROUP_VIEW_ROW_LIMIT);
        },
        exportFileName(ext) {
            const safeKeyword = (this.keywordInfo?.text || 'result').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 30);
            return timestampedFilename(`${t('search.filePrefix')}_${safeKeyword}`, ext);
        },
        async exportResults(format) {
            if (!this.hits.length) return;
            if (format === 'csv') {
                await saveFile(buildSearchCsv(this.detailRows), this.exportFileName('csv'), '*.csv');
                return;
            }
            if (typeof XLSX === 'undefined') {
                ElementPlus.ElMessage.error(t('result.xlsxMissing'));
                return;
            }
            const workbook = XLSX.utils.book_new();
            for (const sheet of buildSearchSheets(this.hits, this.detailRows, { multiDatabase: this.multiDatabase })) {
                XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([sheet.header, ...sheet.rows]), sheet.name);
            }
            const bytes = new Uint8Array(XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }));
            await saveFile('base64:' + bytesToBase64(bytes), this.exportFileName('xlsx'), '*.xlsx');
        },
    },
    template: `
        <el-dialog
            :model-value="show"
            @update:model-value="$emit('close')"
            width="92vw"
            top="4vh"
            destroy-on-close
            append-to-body
            class="table-search-dialog"
        >
            <template #header>
                <div class="ts-title">
                    <span class="ts-title-text">{{ $t('menu.searchAllTables') }}</span>
                    <span v-if="sourceName" class="ts-title-source">{{ sourceName }}</span>
                </div>
            </template>

            <div class="ts">
                <div class="ts-searchbar">
                    <el-input ref="keywordInput" v-model="form.keyword" size="large" clearable :disabled="running"
                        class="ts-keyword"
                        :placeholder="$t('search.keywordPlaceholder')"
                        @keyup.enter="startSearch">
                        <template #prefix><span class="ts-keyword-icon">⌕</span></template>
                    </el-input>
                    <el-radio-group v-model="form.matchMode" size="large" :disabled="running" class="ts-match">
                        <el-radio-button v-for="o in matchModeOptions" :key="o.value" :value="o.value">{{ $t(o.labelKey) }}</el-radio-button>
                    </el-radio-group>
                    <el-button v-if="!running" type="primary" size="large" class="ts-go" @click="startSearch" :disabled="!form.keyword.trim()">{{ $t('search.search') }}</el-button>
                    <el-button v-else type="danger" size="large" class="ts-go" @click="stop">{{ $t('ai.stop') }}</el-button>
                </div>

                <div class="ts-conditions">
                    <div class="ts-cond-row">
                        <span class="ts-cond-label">{{ $t('search.scope') }}</span>
                        <el-select v-if="!isSqlite" v-model="form.databases" multiple collapse-tags collapse-tags-tooltip
                            filterable clearable :disabled="running" :placeholder="databasePlaceholder"
                            class="ts-db">
                            <el-option v-for="d in databaseOptions" :key="d" :value="d" :label="d === currentDatabase ? $t('search.current', { name: d }) : d" />
                        </el-select>
                        <el-input v-model="form.tableInclude" clearable :disabled="running" class="ts-grow" :placeholder="$t('search.tableIncludePlaceholder')">
                            <template #prepend>{{ $t('search.tableInclude') }}</template>
                        </el-input>
                        <el-input v-model="form.tableExclude" clearable :disabled="running" class="ts-grow" :placeholder="$t('field.example', { value: 'log, *_bak' })">
                            <template #prepend>{{ $t('search.tableExclude') }}</template>
                        </el-input>
                        <el-popover placement="bottom-end" :width="360" trigger="click">
                            <template #reference>
                                <span class="ts-preview-link" :class="{ 'is-error': tablePreview.error }">{{ previewLabel }} ▾</span>
                            </template>
                            <div class="ts-preview-list">
                                <div v-if="!previewTables.length" class="ts-muted">{{ $t('migrate.noMatch') }}</div>
                                <div v-for="t in previewTables" :key="t.database + '.' + t.table" class="ts-preview-item">
                                    <span v-if="!isSqlite" class="ts-muted">{{ t.database }}.</span>{{ t.table }}
                                </div>
                                <div v-if="tablePreview.tables.length > previewTables.length" class="ts-muted">
                                    {{ $t('search.moreTables', { count: tablePreview.tables.length - previewTables.length }) }}
                                </div>
                            </div>
                        </el-popover>
                    </div>
                    <div class="ts-cond-row">
                        <span class="ts-cond-label">{{ $t('object.columns') }}</span>
                        <el-checkbox-group v-model="form.columnTypes" :disabled="running" class="ts-types">
                            <el-checkbox-button v-for="o in columnTypeOptions" :key="o.value" :value="o.value">{{ $t(o.labelKey) }}</el-checkbox-button>
                        </el-checkbox-group>
                        <el-input v-model="form.columnName" clearable :disabled="running" class="ts-grow" :placeholder="$t('search.columnNamePlaceholder')">
                            <template #prepend>{{ $t('search.columnName') }}</template>
                        </el-input>
                        <span class="ts-inline-label">{{ $t('search.limitPerTable') }}</span>
                        <el-input-number v-model="form.limit" :min="1" :max="100000000" :step="50" :precision="0"
                            controls-position="right" :disabled="running || form.unlimited" class="ts-limit" />
                        <el-tooltip :content="$t('search.unlimitedTip')" placement="top">
                            <el-checkbox v-model="form.unlimited" :disabled="running">{{ $t('search.unlimited') }}</el-checkbox>
                        </el-tooltip>
                    </div>
                    <div class="ts-cond-row">
                        <span class="ts-cond-label">{{ $t('search.filter') }}</span>
                        <el-input v-model="form.where" clearable :disabled="running" class="ts-grow ts-where"
                            :placeholder="$t('search.wherePlaceholder')"
                            @keyup.enter="startSearch">
                            <template #prepend>WHERE</template>
                        </el-input>
                    </div>
                </div>

                <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="ts-alert" />

                <div v-if="searchedOnce || running" class="ts-status">
                    <div class="ts-status-main">
                        <el-progress :percentage="progressPercent" :stroke-width="4" :show-text="false" class="ts-progress"
                            :status="running ? '' : 'success'" />
                        <span class="ts-status-text">{{ statusText }}</span>
                        <span v-if="failures.length" class="ts-failure-link" @click="showFailures = !showFailures">
                            {{ $t('search.failedTables', { count: failures.length }) }} {{ showFailures ? '▴' : '▾' }}
                        </span>
                        <el-dropdown trigger="click" :disabled="!hits.length" @command="exportResults">
                            <el-button size="small" :disabled="!hits.length">{{ $t('search.export') }} ▾</el-button>
                            <template #dropdown>
                                <el-dropdown-menu>
                                    <el-dropdown-item command="xlsx">{{ $t('search.exportXlsx') }}</el-dropdown-item>
                                    <el-dropdown-item command="csv">{{ $t('search.exportCsv') }}</el-dropdown-item>
                                </el-dropdown-menu>
                            </template>
                        </el-dropdown>
                        <el-radio-group v-model="viewMode" size="small" class="ts-view">
                            <el-radio-button value="detail">{{ $t('search.viewDetail') }}</el-radio-button>
                            <el-radio-button value="table">{{ $t('search.viewByTable') }}</el-radio-button>
                        </el-radio-group>
                    </div>
                    <div v-if="keywordTags.length || warnings.length" class="ts-status-sub">
                        <span class="ts-muted">{{ $t('search.keywordAs') }}</span>
                        <span v-for="tag in keywordTags" :key="tag" class="ts-chip">{{ tag }}</span>
                        <span v-for="w in warnings" :key="w" class="ts-warning">⚠ {{ w }}</span>
                    </div>
                    <div v-if="showFailures" class="ts-failures">
                        <div v-for="f in failures" :key="f.database + '.' + f.table" class="ts-failure">
                            <span class="ts-mono">{{ isSqlite ? f.table : f.database + '.' + f.table }}</span>
                            <span>{{ f.error }}</span>
                        </div>
                    </div>
                </div>

                <div class="ts-results">
                    <div v-if="!searchedOnce && !running" class="ts-empty">
                        <div class="ts-empty-title">{{ $t('search.introTitle') }}</div>
                        <div>{{ $t('search.introLine1') }}</div>
                        <div>{{ $t('search.introLine2') }}</div>
                    </div>
                    <div v-else-if="!running && !hits.length" class="ts-empty">{{ $t('search.noResults') }}</div>

                    <template v-else-if="viewMode === 'detail'">
                        <div class="ts-detail-wrap">
                            <table class="ts-detail">
                                <thead>
                                    <tr>
                                        <th class="ts-col-index">#</th>
                                        <th v-if="multiDatabase">{{ databaseLabel }}</th>
                                        <th>{{ $t('search.colTable') }}</th>
                                        <th>{{ $t('search.colRecordId') }}</th>
                                        <th>{{ $t('search.colColumn') }}</th>
                                        <th>{{ $t('search.colComment') }}</th>
                                        <th>{{ $t('search.colValue') }}</th>
                                        <th class="ts-col-actions">{{ $t('sessions.colActions') }}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr v-for="(row, i) in detailPageRows" :key="row.key">
                                        <td class="ts-col-index">{{ (detailPage - 1) * detailPageSize + i + 1 }}</td>
                                        <td v-if="multiDatabase" class="ts-mono">{{ row.database }}</td>
                                        <td class="ts-mono" :title="row.table">{{ row.table }}</td>
                                        <td class="ts-mono" :title="String(row.recordId)">{{ row.recordId }}</td>
                                        <td class="ts-mono ts-hit-col">{{ row.column }}</td>
                                        <td :title="row.comment">{{ row.comment }}</td>
                                        <td class="ts-value" :class="{ 'is-null': row.value === null }" :title="formatCell(row.value)">
                                            <template v-for="(part, pi) in highlight(row.value)" :key="pi"><mark v-if="part.hit">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template>
                                        </td>
                                        <td class="ts-col-actions">
                                            <el-button size="small" text @click="$emit('copy', formatCell(row.value))">{{ $t('common.copy') }}</el-button>
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                        <div v-if="detailRows.length > detailPageSize" class="ts-pager">
                            <el-pagination v-model:current-page="detailPage" :page-size="detailPageSize"
                                :total="detailRows.length" layout="total, prev, pager, next" size="small" background />
                        </div>
                    </template>

                    <template v-else>
                        <div v-for="hit in hits" :key="hit.key" class="ts-hit">
                            <div class="ts-hit-head" @click="toggle(hit)">
                                <span class="ts-chevron">{{ expanded[hit.key] ? '▾' : '▸' }}</span>
                                <span class="ts-mono ts-hit-table">{{ isSqlite ? hit.table : hit.key }}</span>
                                <span class="ts-muted">{{ hitCountLabel(hit) }}</span>
                                <span class="ts-hit-columns">
                                    <span v-for="c in hit.matchedColumns" :key="c" class="ts-tag">{{ c }}</span>
                                </span>
                                <span class="ts-hit-actions" @click.stop>
                                    <el-button size="small" text @click="$emit('copy', hit.sql)">{{ $t('ai.copySql') }}</el-button>
                                </span>
                            </div>
                            <div v-if="expanded[hit.key]" class="ts-grid-wrap">
                                <table class="ts-grid">
                                    <thead>
                                        <tr><th v-for="col in hit.columns" :key="col" :class="{ 'is-search-col': hit.matchedColumns.includes(col) }">{{ col }}</th></tr>
                                    </thead>
                                    <tbody>
                                        <tr v-for="(row, rowIndex) in groupRows(hit)" :key="rowIndex">
                                            <td v-for="(value, colIndex) in row" :key="colIndex"
                                                :class="{ 'is-hit': isMatched(hit, rowIndex, hit.columns[colIndex]), 'is-null': value === null }"
                                                :title="formatCell(value)">{{ formatCell(value) }}</td>
                                        </tr>
                                    </tbody>
                                </table>
                                <div v-if="groupRowsHidden(hit)" class="ts-grid-more">
                                    {{ $t('search.moreRows', { count: groupRowsHidden(hit) }) }}
                                </div>
                            </div>
                        </div>
                    </template>
                </div>
            </div>
        </el-dialog>
    `,
};
