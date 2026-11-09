import ResultTable from './ResultTable.js?v=result-table-20261016';
import { buildMongoInsertOneCommand } from '../utils/mongoCommands.js';
import { buildRedisSetCommand, formatRedisArgument } from '../utils/redisCommands.js';
import { formatSqlLiteral, quoteTableName } from '../utils/sqlHelpers.js';
import { bytesToBase64, saveFile, timestampedFilename } from '../utils/saveFile.js';
import { t } from '../i18n/index.js';

export { bytesToBase64 };

// 后端按原始列顺序返回；若用户在界面上拖动调整过列顺序，且列名唯一，则按界面顺序重排
export function alignExportColumns(displayColumns, columns, rows) {
    const unique = new Set(columns).size === columns.length;
    const sameSet = displayColumns.length === columns.length && displayColumns.every(col => columns.includes(col));
    if (!unique || !sameSet || displayColumns.every((col, i) => col === columns[i])) {
        return { cols: columns, rows };
    }
    const order = displayColumns.map(col => columns.indexOf(col));
    return {
        cols: [...displayColumns],
        rows: rows.map(row => (Array.isArray(row) ? order.map(i => row[i]) : row)),
    };
}


export default {
    inject: ['dbService'],
    props: {
        queryResult: { type: Object, required: true },
        pagination: { type: Object, default: null },
        showTabs: { type: Boolean, default: true },
        // 导出全部结果所需的信息 { sourceId, query }；为空时只能导出当前页
        exportAll: { type: Object, default: null },
    },
    emits: ['copy', 'refresh', 'page-change'],
    components: { ResultTable },
    data() {
        return {
            activeTab: 'result',
            showModal: false,
            detailValue: '',
            detailColumn: '',
            detailRow: null,
            detailColumnIndex: -1,
            detailOriginalValue: null,
            detailEditable: false,
            isJson: false,
            columnWidths: {},
            currentPage: 1,
            pageSize: 100,
            showExportMenu: false,
            exportScope: 'page',
            submenuFlip: { up: false, left: false },
            exporting: false,
            sortColumn: null,
            sortDirection: null,
            searchText: '',
            rowContextMenu: { show: false, x: 0, y: 0, row: null, rowIndex: -1, column: null, columnIndex: -1 },
        };
    },
    computed: {
        statements() {
            return Array.isArray(this.queryResult.statements) ? this.queryResult.statements : [];
        },
        activeStatementIndex() {
            const idx = Number(this.queryResult.activeStatementIndex);
            return Number.isInteger(idx) && idx >= 0 ? idx : 0;
        },
        activeStatement() {
            if (!this.statements.length) return null;
            const idx = this.activeStatementIndex;
            return this.statements[idx] || this.statements[this.statements.length - 1];
        },
        displayColumns() {
            return this.activeStatement?.columns || this.queryResult.columns || [];
        },
        displayRows() {
            return this.activeStatement?.data || this.queryResult.rows || [];
        },
        exportTotal() {
            const total = Number(this.pagination?.total);
            return Number.isFinite(total) ? total : null;
        },
        canExportAll() {
            return Boolean(this.exportAll?.sourceId && this.exportAll?.query)
                && this.exportTotal !== null
                && this.exportTotal > this.displayRows.length;
        },
        displayColumnMetadata() {
            return this.activeStatement?.column_metadata || this.queryResult.column_metadata || {};
        },
        displayRowCount() {
            return this.activeStatement?.row_count ?? this.queryResult.rowCount ?? 0;
        },
        displaySql() {
            return this.activeStatement?.executed_query || this.activeStatement?.sql || this.queryResult.executedSql || '';
        },
        displayOperationKind() {
            return this.activeStatement?.operation_kind || this.queryResult.operationKind || '';
        },
        editableInfo() {
            return this.queryResult.editable || { enabled: false };
        },
        rowCopyLabel() {
            const providerId = this.queryResult?.providerId || this.queryResult?.provider_id;
            if (providerId === 'mongodb') return t('provider.copyCommand', { command: 'insertOne' });
            return providerId === 'redis' ? t('provider.copyCommand', { command: 'SET' }) : t('provider.copyInsert');
        },
        supportsSqlInsertExport() {
            const providerId = this.queryResult?.providerId || this.queryResult?.provider_id;
            return ['mysql', 'postgresql', 'sqlite'].includes(providerId);
        },
        editablePrimaryKeys() {
            const pk = this.editableInfo.primaryKey;
            if (Array.isArray(pk)) return pk.filter(Boolean);
            return pk ? [pk] : [];
        },
        filteredRows() {
            const q = (this.searchText || '').trim().toLowerCase();
            if (!q) return this.displayRows;
            const cols = this.displayColumns;
            return this.displayRows.filter(row =>
                cols.some((col, idx) => {
                    const v = Array.isArray(row) ? row[idx] : row[col];
                    if (v === null || v === undefined) return false;
                    return String(v).toLowerCase().includes(q);
                })
            );
        },
        sortedRows() {
            const rows = this.filteredRows;
            if (!this.sortColumn || !this.sortDirection) return rows;
            const col = this.sortColumn;
            const cols = this.displayColumns;
            const idx = cols.indexOf(col);
            const dir = this.sortDirection === 'asc' ? 1 : -1;
            return [...rows].sort((a, b) => {
                const va = Array.isArray(a) ? a[idx] : a[col];
                const vb = Array.isArray(b) ? b[idx] : b[col];
                if (va === null || va === undefined) return 1;
                if (vb === null || vb === undefined) return -1;
                if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
                return String(va).localeCompare(String(vb), undefined, { numeric: true }) * dir;
            });
        },
        totalRows() {
            return this.sortedRows.length;
        },
        hasExternalPagination() {
            return Boolean(this.pagination);
        },
        totalPages() {
            return Math.max(Math.ceil(this.totalRows / this.pageSize), 1);
        },
        pageStart() {
            return Math.min((this.currentPage - 1) * this.pageSize, this.totalRows);
        },
        pageEnd() {
            return Math.min(this.pageStart + this.pageSize, this.totalRows);
        },
        pagedRows() {
            if (this.hasExternalPagination) return this.sortedRows;
            return this.sortedRows.slice(this.pageStart, this.pageEnd);
        },
        pendingRows() {
            return this.displayRows.filter(row => this.isPendingRow(row));
        }
    },
    watch: {
        'queryResult.executedSql'() {
            this.activeTab = 'result';
            this.columnWidths = {};
            this.currentPage = 1;
            this.showExportMenu = false;
            this.sortColumn = null;
            this.sortDirection = null;
            this.searchText = '';
            this.closeRowContextMenu();
        },
        activeStatementIndex() {
            this.sortColumn = null;
            this.sortDirection = null;
            this.searchText = '';
        },
        searchText() { this.currentPage = 1; },
        canExportAll(value) {
            if (!value) this.exportScope = 'page';
        },
    },
    methods: {
        selectStatement(idx) {
            this.queryResult.activeStatementIndex = idx;
            this.columnWidths = {};
            this.currentPage = 1;
        },
        formatDuration(ms) {
            if (ms === null || ms === undefined || ms === '') return '';
            const value = Number(ms);
            if (!Number.isFinite(value)) return '';
            if (value >= 1000) return (value / 1000).toFixed(3) + 's';
            return value.toFixed(value >= 10 ? 1 : 2) + 'ms';
        },
        statementKindLabel(stmt) {
            if (stmt?.columns?.length) return t('result.kindResult');
            if (stmt?.affected_rows !== null && stmt?.affected_rows !== undefined) return 'OK';
            return stmt?.operation_kind || t('result.kindStatement');
        },
        getCellValue(row, col, idx) {
            return Array.isArray(row) ? row[idx] : row[col];
        },
        goPage(delta) {
            const next = Math.min(Math.max(this.currentPage + delta, 1), this.totalPages);
            this.currentPage = next;
        },
        toggleSort(col) {
            if (this.sortColumn !== col) {
                this.sortColumn = col;
                this.sortDirection = 'asc';
            } else if (this.sortDirection === 'asc') {
                this.sortDirection = 'desc';
            } else {
                this.sortColumn = null;
                this.sortDirection = null;
            }
            this.currentPage = 1;
        },
        clearSearch() { this.searchText = ''; },
        closeMenus() {
            this.closeExportMenu();
            this.closeRowContextMenu();
        },
        closeRowContextMenu() {
            this.rowContextMenu.show = false;
            this.rowContextMenu.row = null;
            this.rowContextMenu.rowIndex = -1;
            this.rowContextMenu.column = null;
            this.rowContextMenu.columnIndex = -1;
        },
        async onRowContextMenu({ event, row, rowIndex, column = null, columnIndex = -1 }) {
            this.closeExportMenu();
            this.rowContextMenu = { show: true, x: event.clientX, y: event.clientY, row, rowIndex, column, columnIndex };
            await this.$nextTick();
            const menuEl = this.$el.querySelector('.result-row-context-menu');
            if (!menuEl) return;
            const margin = 8;
            const submenuReserve = 150;
            const rect = menuEl.getBoundingClientRect();
            const maxX = window.innerWidth - rect.width - submenuReserve - margin;
            const maxY = window.innerHeight - rect.height - margin;
            const nextX = event.clientX + rect.width + submenuReserve > window.innerWidth - margin ? event.clientX - rect.width : event.clientX;
            const nextY = event.clientY + rect.height > window.innerHeight - margin ? event.clientY - rect.height : event.clientY;
            this.rowContextMenu.x = Math.max(margin, Math.min(nextX, maxX));
            this.rowContextMenu.y = Math.max(margin, Math.min(nextY, maxY));
        },
        onResizeColumn(colIdx, width) {
            const col = this.displayColumns[colIdx];
            if (col) {
                this.columnWidths = { ...this.columnWidths, [col]: width };
            }
        },
        onReorderColumns(fromIdx, toIdx) {
            const oldCols = this.displayColumns;
            if (!oldCols.length) return;
            const cols = [...oldCols];
            // perm[j] = 原始列数组中，现在位于第 j 列的那一列的旧下标。
            // 对 cols 和 perm 做同样的 splice，保证两者一一对应。
            const perm = oldCols.map((_, i) => i);
            const draggedCol = cols.splice(fromIdx, 1)[0];
            const draggedIdx = perm.splice(fromIdx, 1)[0];
            cols.splice(toIdx, 0, draggedCol);
            perm.splice(toIdx, 0, draggedIdx);
            // 行数据是按旧列顺序的位置数组，必须同步重排，否则表头换了顺序、
            // 下面的列还会按旧位置取值。对象行按键名取值，无需调整。
            const newRows = this.displayRows.map(row =>
                Array.isArray(row) ? perm.map(i => row[i]) : row
            );
            if (this.activeStatement) {
                this.activeStatement.columns = cols;
                this.activeStatement.data = newRows;
            } else {
                this.queryResult.columns = cols;
                this.queryResult.rows = newRows;
            }
        },
        getRowValue(row, col, idx = null) {
            if (Array.isArray(row)) {
                const colIdx = idx === null ? this.displayColumns.indexOf(col) : idx;
                return row[colIdx];
            }
            return row[col];
        },
        setRowValue(row, col, value) {
            const idx = this.displayColumns.indexOf(col);
            if (Array.isArray(row)) {
                if (idx >= 0) row[idx] = value;
            } else {
                row[col] = value;
            }
        },
        buildEditWhere(row) {
            const where = {};
            for (const pk of this.editablePrimaryKeys) {
                const idx = this.displayColumns.indexOf(pk);
                if (idx < 0) return null;
                where[this.sourceColumnName(pk)] = this.getRowValue(row, pk, idx);
            }
            return where;
        },
        sourceColumnName(displayColumn) {
            return this.displayColumnMetadata?.[displayColumn]?.source_column || displayColumn;
        },
        currentTableName() {
            return this.editableInfo?.table || 'current_table';
        },
        sqlIdentifier(name) {
            const providerId = this.queryResult?.providerId || this.queryResult?.provider_id;
            const quote = providerId === 'mysql' ? '`' : '"';
            return quote + String(name).split(quote).join(quote + quote) + quote;
        },
        sqlTableIdentifier(name) {
            return quoteTableName(name, this.queryResult?.providerId || this.queryResult?.provider_id);
        },
        sqlLiteral(value) {
            return formatSqlLiteral(value, this.queryResult?.providerId || this.queryResult?.provider_id);
        },
        redisArgument(value) {
            return formatRedisArgument(value);
        },
        editableColumn(displayColumn) {
            const sourceCol = this.sourceColumnName(displayColumn);
            return (this.editableInfo.columns || []).find(col =>
                String(col.name) === String(displayColumn) || String(col.name) === String(sourceCol) || String(col.source_column) === String(sourceCol)
            ) || {};
        },
        isGeneratedColumn(displayColumn) {
            const meta = this.editableColumn(displayColumn);
            const extra = String(meta.extra || '').toLowerCase();
            return extra.includes('auto_increment')
                || extra.includes('identity')
                || extra.includes('generated');
        },
        hasColumnDefault(displayColumn) {
            const meta = this.editableColumn(displayColumn);
            return meta.default !== undefined && meta.default !== null && String(meta.default).toUpperCase() !== 'NULL';
        },
        defaultInsertValue(displayColumn) {
            const meta = this.editableColumn(displayColumn);
            if (meta.nullable !== false) return null;
            const type = String(meta.type || '').toLowerCase();
            if (/int|decimal|numeric|float|double|real|number/.test(type)) return 0;
            if (/bool|bit/.test(type)) return false;
            if (/json/.test(type)) return '{}';
            if (/date|time|year/.test(type)) return null;
            return '';
        },
        rowToSourceData(row, { includeGenerated = false, useDefaults = false } = {}) {
            const data = {};
            this.displayColumns.forEach((col, idx) => {
                if (!includeGenerated && this.isGeneratedColumn(col)) return;
                if (useDefaults && this.hasColumnDefault(col)) return;
                const sourceCol = this.sourceColumnName(col);
                data[sourceCol] = useDefaults ? this.defaultInsertValue(col) : this.getRowValue(row, col, idx);
            });
            return data;
        },
        rowToDisplayRow(data, templateRow = this.rowContextMenu.row) {
            if (Array.isArray(templateRow)) {
                return this.displayColumns.map(col => this.isGeneratedColumn(col) ? null : data[this.sourceColumnName(col)] ?? null);
            }
            const row = {};
            this.displayColumns.forEach(col => {
                row[col] = this.isGeneratedColumn(col) ? null : data[this.sourceColumnName(col)] ?? null;
            });
            return row;
        },
        makePendingRow(data, templateRow, mode) {
            const row = this.rowToDisplayRow(data, templateRow);
            row.__pendingInsert = true;
            row.__pendingMode = mode;
            return row;
        },
        isPendingRow(row) {
            return Boolean(row?.__pendingInsert);
        },
        rowsTarget() {
            return this.activeStatement?.data || this.queryResult.rows;
        },
        insertDisplayRowAfter(anchorRow, newRow) {
            const rows = this.rowsTarget();
            if (!Array.isArray(rows)) return;
            const idx = rows.indexOf(anchorRow);
            rows.splice(idx >= 0 ? idx + 1 : rows.length, 0, newRow);
            this.queryResult.rowCount = (this.queryResult.rowCount || 0) + 1;
            if (this.activeStatement) this.activeStatement.row_count = (this.activeStatement.row_count || 0) + 1;
        },
        removeDisplayRow(row) {
            const rows = this.rowsTarget();
            if (!Array.isArray(rows)) return;
            const idx = rows.indexOf(row);
            if (idx >= 0) rows.splice(idx, 1);
            this.queryResult.rowCount = Math.max((this.queryResult.rowCount || 0) - 1, 0);
            if (this.activeStatement) this.activeStatement.row_count = Math.max((this.activeStatement.row_count || 0) - 1, 0);
        },
        copyRowInsert() {
            const row = this.rowContextMenu.row;
            if (!row) return;
            const data = this.rowToSourceData(row, { includeGenerated: false });
            const providerId = this.queryResult?.providerId || this.queryResult?.provider_id;
            if (providerId === 'mongodb') {
                const command = buildMongoInsertOneCommand(this.currentTableName(), data);
                this.$emit('copy', command);
                this.closeRowContextMenu();
                return;
            }
            if (providerId === 'redis') {
                if (!Object.prototype.hasOwnProperty.call(data, 'key')
                    || !Object.prototype.hasOwnProperty.call(data, 'value')) {
                    ElementPlus.ElMessage.warning(t('result.redisSetUnavailable'));
                    return;
                }
                const command = buildRedisSetCommand(data.key, data.value);
                this.$emit('copy', command);
                this.closeRowContextMenu();
                return;
            }
            const columns = Object.keys(data);
            if (!columns.length) {
                ElementPlus.ElMessage.warning(t('result.rowNoColumns'));
                return;
            }
            const sql = `INSERT INTO ${this.sqlTableIdentifier(this.currentTableName())} (${columns.map(col => this.sqlIdentifier(col)).join(', ')}) VALUES (${columns.map(col => this.sqlLiteral(data[col])).join(', ')});`;
            this.$emit('copy', sql);
            this.closeRowContextMenu();
        },
        async createRowFromContext({ duplicate = false } = {}) {
            if (!this.editableInfo.enabled) {
                ElementPlus.ElMessage.warning(t(this.editableInfo.reason || 'result.readOnlyResult'));
                return;
            }
            const anchorRow = this.rowContextMenu.row;
            if (!anchorRow) return;
            const data = duplicate
                ? this.rowToSourceData(anchorRow, { includeGenerated: false })
                : this.rowToSourceData(anchorRow, { includeGenerated: false, useDefaults: true });
            if (!Object.keys(data).length) {
                ElementPlus.ElMessage.warning(t('result.resultNoColumns'));
                return;
            }
            this.insertDisplayRowAfter(anchorRow, this.makePendingRow(data, anchorRow, duplicate ? 'duplicate' : 'new'));
            ElementPlus.ElMessage.info(duplicate ? t('result.rowDuplicatedLocally') : t('result.rowAddedLocally'));
            this.closeRowContextMenu();
        },
        async savePendingRow(row = this.rowContextMenu.row) {
            if (!this.editableInfo.enabled) {
                ElementPlus.ElMessage.warning(t(this.editableInfo.reason || 'result.readOnlyResult'));
                return;
            }
            if (!this.isPendingRow(row)) return;
            const data = this.rowToSourceData(row, { includeGenerated: false });
            if (!Object.keys(data).length) {
                ElementPlus.ElMessage.warning(t('result.rowNoColumns'));
                return;
            }
            try {
                const result = await this.dbService.editData(
                    this.editableInfo.sourceId,
                    this.editableInfo.table,
                    'insert',
                    data
                );
                if (result?.success) {
                    row.__pendingInsert = false;
                    ElementPlus.ElMessage.success(t('common.saved'));
                    this.closeRowContextMenu();
                    this.$emit('refresh');
                } else {
                    ElementPlus.ElMessage.error(result?.error || t('result.insertFailed'));
                }
            } catch (e) {
                ElementPlus.ElMessage.error(e.message || t('result.insertFailed'));
            }
        },
        async setContextCellNull() {
            if (!this.editableInfo.enabled) {
                ElementPlus.ElMessage.warning(t(this.editableInfo.reason || 'result.readOnlyResult'));
                return;
            }
            const row = this.rowContextMenu.row;
            const column = this.rowContextMenu.column;
            if (!row || !column) return;
            if (this.isPendingRow(row)) {
                this.setRowValue(row, column, null);
                ElementPlus.ElMessage.info(t('result.nullLocally'));
                this.closeRowContextMenu();
                return;
            }
            const where = this.buildEditWhere(row);
            if (!where) {
                ElementPlus.ElMessage.warning(t('result.noKeyUpdate'));
                return;
            }
            try {
                const sourceColumn = this.sourceColumnName(column);
                const result = await this.dbService.editData(
                    this.editableInfo.sourceId,
                    this.editableInfo.table,
                    'update',
                    { [sourceColumn]: null },
                    where
                );
                if (result?.success) {
                    this.setRowValue(row, column, null);
                    ElementPlus.ElMessage.success(t('result.setNullDone'));
                    this.closeRowContextMenu();
                } else {
                    ElementPlus.ElMessage.error(result?.error || t('result.updateFailed'));
                }
            } catch (e) {
                ElementPlus.ElMessage.error(e.message || t('result.updateFailed'));
            }
        },
        async deleteContextRow() {
            if (!this.editableInfo.enabled) {
                ElementPlus.ElMessage.warning(t(this.editableInfo.reason || 'result.readOnlyResult'));
                return;
            }
            const row = this.rowContextMenu.row;
            if (!row) return;
            if (this.isPendingRow(row)) {
                this.removeDisplayRow(row);
                ElementPlus.ElMessage.success(t('result.pendingRemoved'));
                this.closeRowContextMenu();
                return;
            }
            const where = this.buildEditWhere(row);
            if (!where) {
                ElementPlus.ElMessage.warning(t('result.noKeyDelete'));
                return;
            }
            const condition = Object.entries(where).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(' AND ');
            this.closeRowContextMenu();
            try {
                await ElementPlus.ElMessageBox.confirm(
                    t('result.deleteConfirm', { table: this.editableInfo.table, condition }),
                    t('result.deleteConfirmTitle'),
                    { type: 'warning', confirmButtonText: t('common.delete'), cancelButtonText: t('common.cancel'), confirmButtonClass: 'el-button--danger' }
                );
            } catch (e) {
                return;
            }
            try {
                const result = await this.dbService.editData(
                    this.editableInfo.sourceId,
                    this.editableInfo.table,
                    'delete',
                    {},
                    where
                );
                if (result?.success) {
                    this.removeDisplayRow(row);
                    ElementPlus.ElMessage.success(t('common.deleted'));
                    this.closeRowContextMenu();
                } else {
                    ElementPlus.ElMessage.error(result?.error || t('result.deleteFailed'));
                }
            } catch (e) {
                ElementPlus.ElMessage.error(e.message || t('result.deleteFailed'));
            }
        },
        parseEditedValue(original, text) {
            if (text === 'null' && (original === null || original === undefined)) return null;
            if (typeof original === 'number') {
                const n = Number(text);
                return Number.isFinite(n) ? n : text;
            }
            if (typeof original === 'boolean') {
                return ['1', 'true', 'yes', '是'].includes(String(text).toLowerCase());
            }
            if (typeof original === 'object' && original !== null) {
                try { return JSON.parse(text); } catch (e) { return text; }
            }
            return text;
        },
        async onCellSave({ row, column, value, originalValue }) {
            if (!this.editableInfo.enabled) return;
            if (Object.is(value, originalValue)) return;
            if (this.isPendingRow(row)) {
                this.setRowValue(row, column, value);
                ElementPlus.ElMessage.info(t('result.editedLocally'));
                return;
            }
            const where = this.buildEditWhere(row);
            if (!where) {
                ElementPlus.ElMessage.warning(t('result.noKeySave'));
                return;
            }
            const sourceColumn = this.sourceColumnName(column);
            try {
                const result = await this.dbService.editData(
                    this.editableInfo.sourceId,
                    this.editableInfo.table,
                    'update',
                    { [sourceColumn]: value },
                    where
                );
                if (result?.success) {
                    this.setRowValue(row, column, value);
                    ElementPlus.ElMessage.success(t('result.cellSaved'));
                } else {
                    ElementPlus.ElMessage.error(result?.error || t('result.saveFailed'));
                }
            } catch (e) {
                ElementPlus.ElMessage.error(e.message || t('result.saveFailed'));
            }
        },
        async saveDetailValue() {
            if (!this.detailEditable || !this.detailRow || !this.detailColumn) return;
            const value = this.parseEditedValue(this.detailOriginalValue, this.detailValue);
            await this.onCellSave({
                row: this.detailRow,
                column: this.detailColumn,
                columnIndex: this.detailColumnIndex,
                rowIndex: -1,
                value,
                originalValue: this.detailOriginalValue
            });
            this.showModal = false;
        },
        onCellDblclick(row, col, idx, rowIdx, colIdx) {
            const val = this.getCellValue(row, col, idx);
            if (val === null || val === undefined) return;
            let text = val;
            if (typeof val === 'object') { text = JSON.stringify(val, null, 2); } else { text = String(val); }
            const isObject = typeof val === 'object';
            let isJsonStr = false;
            if (typeof val === 'string') {
                try { const parsed = JSON.parse(val); if (typeof parsed === 'object' && parsed !== null) isJsonStr = true; } catch (e) {}
            }
            this.detailColumn = col;
            this.detailRow = row;
            this.detailColumnIndex = idx;
            this.detailOriginalValue = val;
            this.detailEditable = Boolean(this.editableInfo.enabled);
            this.isJson = isObject || isJsonStr;
            if (this.isJson) {
                try { const parsed = typeof val === 'object' ? val : JSON.parse(val); this.detailValue = JSON.stringify(parsed, null, 2); } catch (e) { this.detailValue = text; }
            } else { this.detailValue = text; }
            this.showModal = true;
        },
        copyDetailValue() { this.$emit('copy', this.detailValue); },
        // Export methods
        toggleExportMenu() { this.showExportMenu = !this.showExportMenu; },
        closeExportMenu() { this.showExportMenu = false; },
        // 子菜单默认在父项右下展开；放不下时向上 / 向左展开，避免超出窗口看不到
        placeSubmenu(event) {
            const item = event.currentTarget;
            const submenu = item.querySelector('.submenu');
            if (!submenu) return;
            // 子菜单靠 :hover 显示，测量前临时显示（不可见）以拿到真实尺寸
            const { display, visibility } = submenu.style;
            submenu.style.visibility = 'hidden';
            submenu.style.display = 'block';
            const height = submenu.offsetHeight;
            const width = submenu.offsetWidth;
            submenu.style.display = display;
            submenu.style.visibility = visibility;
            const itemRect = item.getBoundingClientRect();
            const margin = 8;
            this.submenuFlip = {
                up: itemRect.top + height > window.innerHeight - margin,
                left: itemRect.right + width > window.innerWidth - margin,
            };
        },
        // 返回本次导出用的 { cols, rows }；导出全部时向后端重新查询，失败返回 null
        async resolveExportData() {
            if (this.exportScope !== 'all' || !this.canExportAll) {
                return { cols: this.displayColumns, rows: this.displayRows };
            }
            this.exporting = true;
            try {
                const res = await this.dbService.exportQuery(this.exportAll.query, this.exportAll.sourceId);
                if (!res?.success) {
                    ElementPlus.ElMessage.error(t('settings.exportFailed', { error: res?.error || t('common.unknownError') }));
                    return null;
                }
                if (res.truncated) {
                    ElementPlus.ElMessage.warning(t('result.exportTruncated', { max: res.max_rows }));
                }
                return alignExportColumns(this.displayColumns, res.columns || [], res.data || []);
            } catch (e) {
                ElementPlus.ElMessage.error(t('settings.exportFailed', { error: e.message || e }));
                return null;
            } finally {
                this.exporting = false;
            }
        },
        exportCellText(value) {
            if (value === null || value === undefined) return '';
            if (typeof value === 'object') return JSON.stringify(value);
            return String(value);
        },
        async exportCSV() {
            this.closeExportMenu();
            const exportData = await this.resolveExportData();
            if (!exportData) return;
            const { cols, rows } = exportData;
            const csvRows = [cols.map(c => `"${c.replace(/"/g, '""')}"`).join(',')];
            for (const row of rows) {
                csvRows.push(cols.map((col, idx) => {
                    const val = this.getCellValue(row, col, idx);
                    if (val === null || val === undefined) return '';
                    const str = this.exportCellText(val).replace(/"/g, '""');
                    return `"${str}"`;
                }).join(','));
            }
            await this._saveFile(csvRows.join('\n'), timestampedFilename('query-result', 'csv'), '*.csv|*.txt');
        },
        async exportJSON() {
            this.closeExportMenu();
            const exportData = await this.resolveExportData();
            if (!exportData) return;
            const { cols, rows } = exportData;
            const data = rows.map(row => {
                const obj = {};
                cols.forEach((col, idx) => { obj[col] = this.getCellValue(row, col, idx); });
                return obj;
            });
            await this._saveFile(JSON.stringify(data, null, 2), timestampedFilename('query-result', 'json'), '*.json');
        },
        async exportXLSX() {
            this.closeExportMenu();
            if (typeof XLSX === 'undefined') {
                ElementPlus.ElMessage.error(t('result.xlsxMissing'));
                return;
            }
            const exportData = await this.resolveExportData();
            if (!exportData) return;
            const { cols, rows } = exportData;
            const data = rows.map(row => {
                const obj = {};
                cols.forEach((col, idx) => {
                    const value = this.getCellValue(row, col, idx);
                    obj[col] = typeof value === 'object' && value !== null
                        ? this.exportCellText(value)
                        : value;
                });
                return obj;
            });
            const ws = XLSX.utils.json_to_sheet(data, { header: cols });
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'Results');
            const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
            const b64 = 'base64:' + bytesToBase64(new Uint8Array(wbout));
            await this._saveFile(b64, timestampedFilename('query-result', 'xlsx'), '*.xlsx');
        },
        async exportSQLInsert() {
            this.closeExportMenu();
            const exportData = await this.resolveExportData();
            if (!exportData) return;
            const { cols, rows } = exportData;
            const tableName = this.editableInfo?.table || 'exported_table';
            const lines = rows.map(row => {
                const vals = cols.map((col, idx) => {
                    const val = this.getCellValue(row, col, idx);
                    return this.sqlLiteral(val);
                }).join(', ');
                const quotedColumns = cols.map(col => this.sqlIdentifier(col)).join(', ');
                return `INSERT INTO ${this.sqlTableIdentifier(tableName)} (${quotedColumns}) VALUES (${vals});`;
            });
            await this._saveFile(lines.join('\n'), timestampedFilename('query-result', 'sql'), '*.sql|*.txt');
        },
        async exportMarkdown() {
            this.closeExportMenu();
            const exportData = await this.resolveExportData();
            if (!exportData) return;
            const { cols, rows } = exportData;
            const header = '| ' + cols.join(' | ') + ' |';
            const sep = '| ' + cols.map(() => '---').join(' | ') + ' |';
            const body = rows.map(row =>
                '| ' + cols.map((col, idx) => this.exportCellText(this.getCellValue(row, col, idx))
                    .replace(/\|/g, '\\|')
                    .replace(/\r?\n/g, '<br>')).join(' | ') + ' |'
            ).join('\n');
            await this._saveFile(header + '\n' + sep + '\n' + body, timestampedFilename('query-result', 'md'), '*.md|*.txt');
        },
        _saveFile(content, filename, fileTypes) {
            return saveFile(content, filename, fileTypes);
        },
    },
    template: `
        <div class="result-area" @click="closeMenus">
            <div class="result-content">
                <div v-if="queryResult.isRunning" class="result-info">
                    <span style="color: #247bbd; font-weight: bold;">{{ $t('result.running') }}</span>
                </div>
                <template v-else>
                    <div v-if="queryResult.error" class="result-error-panel">
                        <div class="result-error-header">
                            <span class="result-error-icon">!</span>
                            <span>{{ $t('result.failed') }}</span>
                            <span v-if="queryResult.errorCode" class="result-error-code">{{ $t('result.errorCode', { code: queryResult.errorCode }) }}</span>
                        </div>
                        <div class="result-error-message">{{ queryResult.errorMsg }}</div>
                        <details style="border-top: 1px solid var(--border-slate); padding-top: 8px;">
                            <summary style="font-size: 12px; color: var(--text-muted); cursor: pointer; outline: none; user-select: none;">{{ $t('result.technicalDetails') }}</summary>
                            <div style="margin-top: 8px; font-family: monospace; font-size: 11px; color: var(--text-secondary); background: var(--surface-bg); padding: 10px; border-radius: 4px; overflow: auto; max-height: 200px;">{{ queryResult.error }}</div>
                        </details>
                    </div>
                    <template v-else-if="queryResult.executedSql">
                        <div v-if="statements.length > 1" class="statement-tabs" style="display:flex; gap:6px; padding:8px 10px; border-bottom:1px solid var(--border-slate); overflow:auto;">
                            <button v-for="(stmt, idx) in statements" :key="'stmt-' + idx"
                                    :class="['result-tab', { active: activeStatementIndex === idx }]"
                                    @click="selectStatement(idx)"
                                    :title="stmt.sql || stmt.executed_query">
                                #{{ idx + 1 }} {{ statementKindLabel(stmt) }}
                                <span v-if="stmt.row_count !== undefined"> · {{ $t('history.rows', { count: stmt.row_count }) }}</span>
                            </button>
                        </div>
                        <div class="result-info">
                            <span class="result-status-ok">{{ $t('result.succeeded') }}</span>
                            <span>({{ queryResult.time }}s) | {{ $t('result.rowsAffected', { count: displayRowCount }) }}</span>
                            <span v-if="searchText && filteredRows.length !== displayRows.length"> | {{ $t('result.filtered', { shown: filteredRows.length, total: displayRows.length }) }}</span>
                            <span v-if="statements.length > 1"> | {{ $t('result.statementCount', { count: statements.length }) }}</span>
                            <span v-if="formatDuration(activeStatement?.duration_ms)"> | {{ $t('result.currentDuration', { time: formatDuration(activeStatement.duration_ms) }) }}</span>
                            <span v-if="displaySql" class="result-executed-sql" :title="displaySql"> | SQL: {{ displaySql }}</span>
                        </div>
                        <template v-if="displayColumns.length">
                            <div class="result-toolbar">
                                <el-input v-model="searchText" :placeholder="$t('result.searchPlaceholder')" :disabled="!displayRows.length" size="small" clearable style="width: 220px;" />
                                <div v-if="hasExternalPagination" class="result-pagination inline">
                                    <span v-if="pagination.loading">{{ $t('result.counting') }}</span>
                                    <span v-else>{{ pagination.start }}-{{ pagination.end }} / {{ pagination.total }}</span>
                                    <el-button size="small" :disabled="pagination.page <= 1 || pagination.disabled" @click="$emit('page-change', -1)">‹</el-button>
                                    <span>{{ pagination.page }} / {{ pagination.totalPages }}</span>
                                    <el-button size="small" :disabled="pagination.page >= pagination.totalPages || pagination.disabled" @click="$emit('page-change', 1)">›</el-button>
                                </div>
                                <div v-else-if="totalRows > pageSize" class="result-pagination inline">
                                    <span>{{ pageStart + 1 }}-{{ pageEnd }} / {{ totalRows }}</span>
                                    <el-button size="small" :disabled="currentPage <= 1" @click="goPage(-1)">‹</el-button>
                                    <span>{{ currentPage }} / {{ totalPages }}</span>
                                    <el-button size="small" :disabled="currentPage >= totalPages" @click="goPage(1)">›</el-button>
                                </div>
                                <span v-if="editableInfo.enabled" class="result-editable-note" :title="$t('result.editableTitle')">
                                    {{ $t('result.editable', { table: editableInfo.table }) }}
                                </span>
                                <el-button
                                    v-if="pendingRows.length"
                                    size="small"
                                    type="primary"
                                    plain
                                    @click="savePendingRow(pendingRows[0])">
                                    {{ $t('result.savePendingRow') }}
                                </el-button>
                                <el-tag v-else-if="editableInfo.reason" size="small" type="info" effect="plain" :title="$t(editableInfo.reason)">
                                    {{ $t('result.readOnly') }}
                                </el-tag>
                                <span v-if="sortColumn" class="sort-active-hint" @click="toggleSort(sortColumn)" :title="$t('result.clearSort')">
                                    {{ $t('result.sortedBy', { column: sortColumn }) }} {{ sortDirection === 'asc' ? '↑' : '↓' }} ✕
                                </span>
                                <div class="result-toolbar-spacer"></div>
                                <el-button size="small" :title="$t('result.refreshTitle')" @click="$emit('refresh')">{{ $t('common.refresh') }}</el-button>
                                <div v-if="displayRows.length > 0" class="result-export-inline">
                                    <el-button size="small" @click.stop="toggleExportMenu" :loading="exporting">{{ exporting ? $t('result.exporting') : $t('common.export') }}</el-button>
                                    <div v-if="showExportMenu" class="export-dropdown" @click.stop>
                                        <div v-if="canExportAll" class="export-scope-switch">
                                            <button type="button" :class="{ active: exportScope === 'page' }" @click="exportScope = 'page'">{{ $t('result.exportPage', { count: displayRows.length }) }}</button>
                                            <button type="button" :class="{ active: exportScope === 'all' }" @click="exportScope = 'all'">{{ $t('result.exportAll', { count: exportTotal }) }}</button>
                                        </div>
                                        <div v-else class="export-scope">{{ $t('result.exportPageOnly', { count: displayRows.length }) }}</div>
                                        <div class="export-item" @click="exportCSV">CSV</div>
                                        <div class="export-item" @click="exportJSON">JSON</div>
                                        <div class="export-item" @click="exportXLSX">XLSX (Excel)</div>
                                        <div v-if="supportsSqlInsertExport" class="export-item" @click="exportSQLInsert">SQL INSERT</div>
                                        <div class="export-item" @click="exportMarkdown">Markdown</div>
                                    </div>
                                </div>
                            </div>
                            <div class="table-container">
                                <result-table
                                    :columns="displayColumns"
                                    :rows="pagedRows"
                                    :column-widths="columnWidths"
                                    :sort-column="sortColumn"
                                    :sort-direction="sortDirection"
                                    :search-text="searchText"
                                    :column-metadata="displayColumnMetadata"
                                    :page-start="pageStart"
                                    :editable="editableInfo"
                                    :selected-row-index="rowContextMenu.rowIndex"
                                    @sort="toggleSort"
                                    @resize-column="onResizeColumn"
                                    @reorder-columns="onReorderColumns"
                                    @cell-dblclick="onCellDblclick"
                                    @cell-save="onCellSave"
                                    @row-contextmenu="onRowContextMenu"
                                ></result-table>
                            </div>
                        </template>
                        <div v-else class="empty-result">
                            {{ $t('result.okAffected', { count: displayRowCount }) }}
                        </div>
                    </template>
                    <div v-else class="empty-result">{{ $t('result.empty') }}</div>
                </template>
            </div>

            <!-- 单元格详情模态框 -->
            <el-dialog :model-value="showModal" @update:model-value="showModal = $event" width="760px" destroy-on-close append-to-body>
                <template #header>
                    <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                        <span style="font-size: 16px; font-weight: 600;">{{ detailEditable ? $t('result.detailEditTitle', { column: detailColumn }) : $t('result.detailViewTitle', { column: detailColumn }) }}</span>
                        <span style="font-size: 12px; color: var(--el-text-color-secondary);">
                            {{ $t('result.charCount', { count: detailValue.length }) }}
                            <el-tag v-if="isJson" type="success" size="small" style="margin-left: 8px;">JSON</el-tag>
                        </span>
                    </div>
                </template>
                <el-input
                    type="textarea"
                    v-model="detailValue"
                    :readonly="!detailEditable"
                    :rows="18"
                    :autofocus="detailEditable"
                    :class="['cell-detail-editor', { 'is-editing': detailEditable }]"
                    style="font-family: monospace;"
                />
                <template #footer>
                    <el-button @click="showModal = false">{{ $t('common.close') }}</el-button>
                    <el-button @click="copyDetailValue">{{ $t('result.copyFullValue') }}</el-button>
                    <el-button v-if="detailEditable" @click="saveDetailValue">{{ $t('common.save') }}</el-button>
                </template>
            </el-dialog>

            <div v-if="rowContextMenu.show"
                 class="context-menu result-row-context-menu"
                 :style="{ top: rowContextMenu.y + 'px', left: rowContextMenu.x + 'px' }"
                 @click.stop>
                <div v-if="isPendingRow(rowContextMenu.row)" class="menu-item" @click="savePendingRow(rowContextMenu.row)">{{ $t('result.savePendingRow') }}</div>
                <div v-if="isPendingRow(rowContextMenu.row)" class="menu-separator"></div>
                <div class="menu-item" @click="copyRowInsert">{{ rowCopyLabel }}</div>
                <div v-if="editableInfo.enabled" class="menu-item" @mouseenter="placeSubmenu">
                    <span>{{ $t('result.editMenu') }}</span><span>›</span>
                    <div :class="['submenu', { 'submenu-up': submenuFlip.up, 'submenu-left': submenuFlip.left }]">
                        <div v-if="rowContextMenu.column" class="menu-item" @click="setContextCellNull">{{ $t('result.setNull') }}</div>
                        <div v-if="rowContextMenu.column" class="menu-separator"></div>
                        <div class="menu-item" @click="createRowFromContext()">{{ $t('result.addRow') }}</div>
                        <div class="menu-item" @click="createRowFromContext({ duplicate: true })">{{ $t('result.duplicateRow') }}</div>
                        <div class="menu-separator"></div>
                        <div class="menu-item danger" @click="deleteContextRow">{{ $t('result.deleteRow') }}</div>
                    </div>
                </div>
            </div>
        </div>
    `
};
