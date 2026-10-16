import ResultArea from './ResultArea.js';

const quoteIdent = (dbType, name) => {
    if (dbType === 'postgresql') return `"${String(name).replace(/"/g, '""')}"`;
    if (dbType === 'mysql' || dbType === 'sqlite') return `\`${String(name).replace(/`/g, '``')}\``;
    return name;
};

const emptyResult = () => ({
    providerId: '',
    columns: [],
    column_metadata: {},
    rows: [],
    rowCount: 0,
    time: 0,
    durationMs: null,
    error: '',
    errorMsg: '',
    errorCode: null,
    executedSql: '',
    operationKind: '',
    statements: [],
    activeStatementIndex: 0,
    editable: { enabled: false, sourceId: null, table: '', primaryKey: null, columns: [], reason: '' },
    isRunning: false,
});

export default {
    inject: ['dbService'],
    components: { ResultArea },
    props: {
        source: { type: Object, required: true },
        table: { type: Object, required: true },
        initialPane: { type: String, default: 'info' },
    },
    emits: ['copy'],
    data() {
        return {
            activePane: 'info',
            primaryKeyColumns: [],
            primaryKeyLoaded: false,
            dataPage: 1,
            dataPageSize: 100,
            dataTotal: 0,
            dataCountLoading: false,
            result: emptyResult(),
            ddl: '',
            ddlError: '',
            ddlHtml: '',
            ddlLoading: false,
        };
    },
    computed: {
        columns() {
            return this.table.columns || [];
        },
        pkColumns() {
            const keys = new Set(this.primaryKeyColumns.map(String));
            const fromColumns = this.columns
                .filter(col => this.isPrimaryKeyColumn(col))
                .map(col => col.name);
            fromColumns.forEach(name => keys.add(String(name)));
            return this.columns
                .map(col => col.name)
                .filter(name => keys.has(String(name)));
        },
        tableNameSql() {
            return quoteIdent(this.source.db_type, this.table.name);
        },
        // DDL 统一以分号结尾，复制后可直接执行
        ddlText() {
            const ddl = String(this.ddl || '').trimEnd();
            if (!ddl) return '';
            return ddl.endsWith(';') ? ddl : ddl + ';';
        },
        dataSql() {
            const offset = (this.dataPage - 1) * this.dataPageSize;
            return `SELECT * FROM ${this.tableNameSql} LIMIT ${this.dataPageSize} OFFSET ${offset}`;
        },
        exportAllSpec() {
            return { sourceId: this.source.id, query: `SELECT * FROM ${this.tableNameSql}` };
        },
        countSql() {
            return `SELECT COUNT(*) AS total FROM ${this.tableNameSql}`;
        },
        dataPageStart() {
            if (!this.dataTotal || !this.result.rows.length) return 0;
            return (this.dataPage - 1) * this.dataPageSize + 1;
        },
        dataPageEnd() {
            if (!this.dataTotal || !this.result.rows.length) return 0;
            return Math.min(this.dataPage * this.dataPageSize, this.dataTotal);
        },
        dataTotalPages() {
            return Math.max(Math.ceil(this.dataTotal / this.dataPageSize), 1);
        },
    },
    watch: {
        table: {
            immediate: true,
            handler() {
                this.activePane = this.initialPane === 'data' ? 'data' : 'info';
                this.dataPage = 1;
                this.dataTotal = 0;
                this.primaryKeyColumns = [];
                this.primaryKeyLoaded = false;
                this.result = emptyResult();
                this.loadDdl();
                this.loadPrimaryKey();
                this.$nextTick(() => {
                    if (this.activePane === 'data' && !this.result.isRunning && !this.result.executedSql) this.loadData();
                });
            }
        },
        initialPane(value) {
            const pane = value === 'data' ? 'data' : 'info';
            if (pane !== this.activePane) this.activePane = pane;
        },
        activePane(value) {
            if (value === 'data' && !this.result.isRunning && !this.result.executedSql) this.loadData();
        },
    },
    methods: {
        normalizePrimaryKey(primaryKey) {
            if (Array.isArray(primaryKey)) return primaryKey.filter(Boolean).map(String);
            return primaryKey ? [String(primaryKey)] : [];
        },
        isPrimaryKeyColumn(col) {
            const name = String(col?.name || '');
            const keyValue = String(col?.key ?? col?.Key ?? col?.COLUMN_KEY ?? '').trim().toUpperCase();
            return this.primaryKeyColumns.map(String).includes(name)
                || col?.primary_key === true
                || String(col?.primary_key).toLowerCase() === 'true'
                || keyValue === 'PRI'
                || keyValue === 'PRIMARY';
        },
        buildEditableContext() {
            return {
                enabled: Boolean(this.pkColumns.length),
                sourceId: this.source.id,
                table: this.table.name,
                primaryKey: this.pkColumns,
                columns: this.columns,
                reason: this.pkColumns.length ? '' : '表没有主键，结果集只读',
            };
        },
        async loadPrimaryKey() {
            if (!this.source?.id || !this.table?.name || this.primaryKeyLoaded) return;
            this.primaryKeyLoaded = true;
            try {
                const res = await this.dbService.getPrimaryKey(this.source.id, this.table.name);
                if (res?.success) this.primaryKeyColumns = this.normalizePrimaryKey(res.primary_key);
            } catch (e) {
                this.primaryKeyColumns = [];
            }
        },
        async loadDdl() {
            if (!this.source?.id || !this.table?.name) return;
            this.ddlLoading = true;
            this.ddl = '';
            this.ddlError = '';
            this.ddlHtml = '';
            try {
                const res = await this.dbService.getDDL(this.table.name, this.source.id);
                if (res.success) this.ddl = res.ddl || '';
                else this.ddlError = res.error || '获取 DDL 失败';
            } catch (e) {
                this.ddlError = e.message || '获取 DDL 失败';
            } finally {
                this.ddlLoading = false;
            }
            await this.highlightDdl();
        },
        // 用 Monaco 的 colorize 做语法高亮（输出已转义 HTML）；Monaco 未加载或失败时退回纯文本
        async highlightDdl() {
            const text = this.ddlText;
            if (!text || typeof monaco === 'undefined' || !monaco.editor?.colorize) return;
            const language = this.source?.db_type === 'postgresql' ? 'pgsql' : 'mysql';
            try {
                const html = await monaco.editor.colorize(text, language, { tabSize: 4 });
                if (text === this.ddlText) this.ddlHtml = html;
            } catch (e) {
                this.ddlHtml = '';
            }
        },
        copyDdl() {
            if (this.ddlText) this.$emit('copy', this.ddlText);
        },
        refreshInfo() {
            this.loadDdl();
            this.primaryKeyLoaded = false;
            this.loadPrimaryKey();
        },
        async loadCount() {
            this.dataCountLoading = true;
            try {
                const data = await this.dbService.executeSql(this.countSql, this.source.id);
                const rows = data?.statements?.[data.active_statement_index || 0]?.data || data?.data || [];
                const first = rows[0];
                const rawTotal = Array.isArray(first) ? first[0] : (first?.total ?? first?.['COUNT(*)'] ?? first?.count);
                const total = Number(rawTotal);
                this.dataTotal = Number.isFinite(total) ? total : 0;
                if (this.dataPage > this.dataTotalPages) this.dataPage = this.dataTotalPages;
            } catch (e) {
                this.dataTotal = 0;
            } finally {
                this.dataCountLoading = false;
            }
        },
        async loadData() {
            this.result.isRunning = true;
            const start = Date.now();
            try {
                await this.loadPrimaryKey();
                await this.loadCount();
                const data = await this.dbService.executeSql(this.dataSql, this.source.id);
                if (data.success === false) {
                    Object.assign(this.result, {
                        ...emptyResult(),
                        error: data.error,
                        errorMsg: data.error_msg || data.error,
                        errorCode: data.error_code,
                        executedSql: this.dataSql,
                    });
                } else {
                    const active = Array.isArray(data.statements) ? data.statements[data.active_statement_index || 0] : null;
                    Object.assign(this.result, {
                        providerId: data.provider_id || this.source.db_type || '',
                        error: '',
                        errorMsg: '',
                        errorCode: null,
                        columns: active?.columns || data.columns || [],
                        column_metadata: active?.column_metadata || data.column_metadata || {},
                        rows: active?.data || data.data || [],
                        rowCount: active?.row_count ?? data.row_count ?? data.data?.length ?? 0,
                        time: ((Date.now() - start) / 1000).toFixed(3),
                        durationMs: data.duration_ms ?? null,
                        executedSql: data.executed_query || data.executed_sql || this.dataSql,
                        operationKind: data.operation_kind || active?.operation_kind || '',
                        statements: data.statements || [],
                        activeStatementIndex: data.active_statement_index || 0,
                        editable: this.buildEditableContext(),
                    });
                }
            } catch (e) {
                Object.assign(this.result, {
                    ...emptyResult(),
                    error: e.detail || e.message || String(e),
                    errorMsg: e.detail || e.message || String(e),
                    errorCode: e.status || 500,
                    executedSql: this.dataSql,
                });
            } finally {
                this.result.isRunning = false;
            }
        },
        changeDataPage(delta) {
            const next = Math.min(Math.max(this.dataPage + delta, 1), this.dataTotalPages);
            if (next === this.dataPage) return;
            this.dataPage = next;
            this.loadData();
        },
    },
    template: `
        <div class="table-object-view">
            <div class="table-object-header">
                <div class="table-object-title">
                    <span class="object-icon">▦</span>
                    <strong>{{ table.name }}</strong>
                    <small v-if="table.comment">{{ table.comment }}</small>
                </div>
                <div class="table-object-meta">
                    <span>{{ columns.length }} 列</span>
                    <span v-if="pkColumns.length">主键：{{ pkColumns.join(', ') }}</span>
                    <span>{{ source.name }} / {{ source.database }}</span>
                </div>
            </div>

            <div class="object-tabs">
                <button :class="{ active: activePane === 'info' }" @click="activePane = 'info'">表信息</button>
                <button :class="{ active: activePane === 'data' }" @click="activePane = 'data'">数据</button>
            </div>

            <div v-if="activePane === 'info'" class="object-pane info-pane">
                <div class="table-info-grid">
                    <section>
                        <div class="section-head">
                            <div class="section-title">字段</div>
                            <button class="section-action" @click="refreshInfo" title="重新读取主键和 DDL">刷新</button>
                        </div>
                        <table class="object-meta-table">
                            <thead>
                                <tr><th class="col-index">#</th><th>字段</th><th>类型</th><th class="col-flag">可空</th><th class="col-flag">主键</th><th>注释</th></tr>
                            </thead>
                            <tbody>
                                <tr v-for="(col, index) in columns" :key="col.name">
                                    <td class="col-index">{{ index + 1 }}</td>
                                    <td class="col-name">{{ col.name }}</td>
                                    <td class="col-type">{{ col.type }}</td>
                                    <td class="col-flag"><span :class="['flag', col.nullable === false ? 'flag-strong' : 'flag-muted']">{{ col.nullable === false ? 'NOT NULL' : 'NULL' }}</span></td>
                                    <td class="col-flag"><span v-if="isPrimaryKeyColumn(col)" class="pk-badge">PK</span></td>
                                    <td class="col-comment">{{ col.comment || '' }}</td>
                                </tr>
                            </tbody>
                        </table>
                    </section>
                    <section>
                        <div class="section-head">
                            <div class="section-title">DDL</div>
                            <button class="section-action" :disabled="!ddlText" @click="copyDdl">复制</button>
                        </div>
                        <pre v-if="ddlLoading" class="object-ddl muted">加载中…</pre>
                        <pre v-else-if="ddlError" class="object-ddl error">{{ ddlError }}</pre>
                        <pre v-else-if="!ddlText" class="object-ddl muted">暂无 DDL</pre>
                        <pre v-else-if="ddlHtml" class="object-ddl" v-html="ddlHtml"></pre>
                        <pre v-else class="object-ddl">{{ ddlText }}</pre>
                    </section>
                </div>
            </div>

            <div v-else-if="activePane === 'data'" class="object-pane data-pane">
                <result-area
                    :query-result="result"
                    :show-tabs="false"
                    :export-all="exportAllSpec"
                    :pagination="{
                        loading: dataCountLoading,
                        start: dataPageStart,
                        end: dataPageEnd,
                        total: dataTotal,
                        page: dataPage,
                        totalPages: dataTotalPages,
                        disabled: result.isRunning
                    }"
                    @page-change="changeDataPage"
                    @copy="$emit('copy', $event)"
                    @refresh="loadData"
                ></result-area>
            </div>

        </div>
    `,
};
