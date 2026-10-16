export default {
    props: {
        columns: { type: Array, default: () => [] },
        rows: { type: Array, default: () => [] },
        columnWidths: { type: Object, default: () => ({}) },
        sortColumn: { type: String, default: null },
        sortDirection: { type: String, default: null },
        searchText: { type: String, default: '' },
        columnMetadata: { type: Object, default: () => ({}) },
        pageStart: { type: Number, default: 0 },
        editable: { type: Object, default: () => ({ enabled: false }) },
        selectedRowIndex: { type: Number, default: -1 },
    },
    emits: ['sort', 'resize-column', 'reorder-columns', 'cell-dblclick', 'cell-save', 'row-contextmenu'],
    data() {
        return {
            draggedColumnIdx: -1,
            dragOverColumnIdx: -1,
            activeInlineCell: { rowIdx: -1, colIdx: -1 },
            inlineEditValue: '',
        };
    },
    watch: {
        columns() {
            this.activeInlineCell = { rowIdx: -1, colIdx: -1 };
        },
    },
    methods: {
        cellStyle(col) {
            const rawWidth = this.columnWidths[col];
            if (rawWidth === undefined || rawWidth === null) return {};
            const width = Math.max(Number(rawWidth) || 0, 28);
            return { width: width + 'px', minWidth: width + 'px', maxWidth: width + 'px', overflow: 'hidden' };
        },
        headerCellStyle(col) {
            return { ...this.cellStyle(col), position: 'relative' };
        },
        getCellValue(row, col, idx) {
            return Array.isArray(row) ? row[idx] : row[col];
        },
        setCellValue(row, col, idx, value) {
            if (Array.isArray(row)) row[idx] = value;
            else row[col] = value;
        },
        getCellDisplayValue(row, col, idx) {
            const val = this.getCellValue(row, col, idx);
            if (val === null || val === undefined) return 'null';
            if (typeof val === 'object') {
                try { return JSON.stringify(val); } catch (e) { return String(val); }
            }
            return String(val);
        },
        getCellEditValue(row, col, idx) {
            const val = this.getCellValue(row, col, idx);
            if (val === null || val === undefined) return '';
            if (typeof val === 'object') {
                try { return JSON.stringify(val); } catch (e) { return String(val); }
            }
            return String(val);
        },
        isCellNull(row, col, idx) {
            const val = this.getCellValue(row, col, idx);
            return val === null || val === undefined;
        },
        isCellNumber(row, col, idx) {
            const val = this.getCellValue(row, col, idx);
            return val !== null && val !== undefined && typeof val === 'number';
        },
        cellMatchedSearch(row, col, idx) {
            const q = (this.searchText || '').trim().toLowerCase();
            if (!q) return false;
            const v = this.getCellValue(row, col, idx);
            return v !== null && v !== undefined && String(v).toLowerCase().includes(q);
        },
        toggleSort(col) {
            this.$emit('sort', col);
        },
        // 表格从自动列宽切到固定布局（table-layout: fixed）时，没有显式宽度的列会被压缩到几乎为 0，
        // 所以第一次设置某列宽度前，先把所有列的当前实际宽度记下来
        freezeColumnWidths(th) {
            const ths = th?.parentElement?.children || [];
            this.columns.forEach((col, i) => {
                const current = this.columnWidths[col];
                if ((current === undefined || current === null) && ths[i]) {
                    this.$emit('resize-column', i, Math.ceil(ths[i].getBoundingClientRect().width));
                }
            });
        },
        autoFitColumn(e, idx) {
            const col = this.columns[idx];
            if (!col) return;
            this.freezeColumnWidths(e.target.closest('th'));
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            ctx.font = '13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
            let maxWidth = ctx.measureText(String(col)).width;
            const sample = this.rows.slice(0, 50);
            for (const row of sample) {
                const val = this.getCellValue(row, col, idx);
                if (val === null || val === undefined) continue;
                const text = typeof val === 'object' ? JSON.stringify(val) : String(val);
                const w = ctx.measureText(text.slice(0, 60)).width;
                if (w > maxWidth) maxWidth = w;
            }
            const newWidth = Math.min(Math.max(Math.ceil(maxWidth) + 28, 60), 400);
            this.$emit('resize-column', idx, newWidth);
        },
        showCellDetail(row, col, idx, rowIdx, colIdx, event) {
            // 单元格换成输入框后不再撑开列宽，先固定所有列宽，避免该列被压窄
            const firstTh = event?.target?.closest('table')?.querySelector('thead th');
            if (firstTh) this.freezeColumnWidths(firstTh);
            const val = this.getCellValue(row, col, idx);
            if (val === null || val === undefined) {
                if (!this.editable?.enabled) return;
                this.activeInlineCell.rowIdx = rowIdx;
                this.activeInlineCell.colIdx = colIdx;
                this.inlineEditValue = '';
                this.$nextTick(() => {
                    const el = document.getElementById(`inline-input-${rowIdx}-${colIdx}`);
                    if (el) { el.focus(); el.select(); }
                });
                return;
            }
            let text = val;
            if (typeof val === 'object') { text = JSON.stringify(val, null, 2); } else { text = String(val); }
            const isObject = typeof val === 'object';
            let isJsonStr = false;
            if (typeof val === 'string') {
                try { const parsed = JSON.parse(val); if (typeof parsed === 'object' && parsed !== null) isJsonStr = true; } catch (e) {}
            }
            const isLong = text.length > 80 || text.includes('\n') || text.includes('\r') || isObject || isJsonStr;
            if (isLong) {
                this.$emit('cell-dblclick', row, col, idx, rowIdx, colIdx);
            } else if (this.editable?.enabled) {
                this.activeInlineCell.rowIdx = rowIdx;
                this.activeInlineCell.colIdx = colIdx;
                this.inlineEditValue = this.getCellEditValue(row, col, idx);
                this.$nextTick(() => {
                    const el = document.getElementById(`inline-input-${rowIdx}-${colIdx}`);
                    if (el) { el.focus(); el.select(); }
                });
            } else {
                this.activeInlineCell.rowIdx = rowIdx;
                this.activeInlineCell.colIdx = colIdx;
                this.inlineEditValue = this.getCellEditValue(row, col, idx);
                this.$nextTick(() => {
                    const el = document.getElementById(`inline-input-${rowIdx}-${colIdx}`);
                    if (el) { el.focus(); el.select(); }
                });
            }
        },
        closeInlineCell() {
            this.activeInlineCell.rowIdx = -1;
            this.activeInlineCell.colIdx = -1;
            this.inlineEditValue = '';
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
        commitInlineCell(row, col, idx, rowIdx, colIdx) {
            if (!this.editable?.enabled) {
                this.closeInlineCell();
                return;
            }
            const original = this.getCellValue(row, col, idx);
            const nextValue = this.parseEditedValue(original, this.inlineEditValue);
            this.$emit('cell-save', { row, column: col, columnIndex: idx, rowIndex: rowIdx, value: nextValue, originalValue: original });
            this.closeInlineCell();
        },
        updatePendingCell(row, col, idx, event) {
            const original = this.getCellValue(row, col, idx);
            const nextValue = this.parseEditedValue(original, event.target.value);
            this.setCellValue(row, col, idx, nextValue);
        },
        startResizeColumn(e, idx) {
            const startX = e.clientX;
            const th = e.target.closest('th');
            const startWidth = th.getBoundingClientRect().width;
            this.freezeColumnWidths(th);
            const onMouseMove = (moveEvent) => {
                const deltaX = moveEvent.clientX - startX;
                const newWidth = Math.max(startWidth + deltaX, 28);
                this.$emit('resize-column', idx, newWidth);
            };
            const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                document.body.style.cursor = '';
            };
            document.body.style.cursor = 'col-resize';
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        },
        dragStart(idx) { this.draggedColumnIdx = idx; },
        dragEnter(idx) { this.dragOverColumnIdx = idx; },
        dragEnd() {
            if (this.draggedColumnIdx !== -1 && this.dragOverColumnIdx !== -1 && this.draggedColumnIdx !== this.dragOverColumnIdx) {
                this.$emit('reorder-columns', this.draggedColumnIdx, this.dragOverColumnIdx);
            }
            this.draggedColumnIdx = -1;
            this.dragOverColumnIdx = -1;
        },
    },
    template: `
        <table class="result-data-table" :style="{ tableLayout: Object.keys(columnWidths).length ? 'fixed' : 'auto', width: Object.keys(columnWidths).length ? 'max-content' : '100%', minWidth: '100%' }">
            <thead>
                <tr>
                    <th v-for="(col, idx) in columns" :key="'col-' + idx"
                        :style="headerCellStyle(col)"
                        draggable="true"
                        @dragstart="dragStart(idx)"
                        @dragenter="dragEnter(idx)"
                        @dragend="dragEnd"
                        @dragover.prevent
                        @click="toggleSort(col)"
                        :class="{
                            'drag-over-left': draggedColumnIdx !== -1 && dragOverColumnIdx === idx && dragOverColumnIdx < draggedColumnIdx,
                            'drag-over-right': draggedColumnIdx !== -1 && dragOverColumnIdx === idx && dragOverColumnIdx > draggedColumnIdx,
                            'dragging-th': draggedColumnIdx === idx,
                            'th-sorted': sortColumn === col
                        }"
                        :title="columnMetadata[col] ? 'Type: ' + columnMetadata[col].type + '\\nComment: ' + columnMetadata[col].comment : ''">
                        <div class="th-content">
                            <span>{{ col }}</span>
                            <span class="sort-arrow" v-if="sortColumn === col">{{ sortDirection === 'asc' ? '▲' : '▼' }}</span>
                        </div>
                        <div class="resize-handle"
                             @mousedown.stop.prevent="startResizeColumn($event, idx)"
                             @click.stop.prevent
                             @dblclick.stop.prevent="autoFitColumn($event, idx)"></div>
                    </th>
                </tr>
            </thead>
            <tbody>
                <tr v-for="(row, i) in rows" :key="'row-' + (pageStart + i)"
                    :class="{ 'result-row-selected': selectedRowIndex === pageStart + i, 'result-row-pending': row && row.__pendingInsert }"
                    @contextmenu.prevent.stop="$emit('row-contextmenu', { event: $event, row, rowIndex: pageStart + i })">
                    <td v-for="(col, idx) in columns" :key="'cell-' + i + '-' + idx"
                        :style="cellStyle(col)"
                        :class="{
                            'editing-cell': activeInlineCell.rowIdx === pageStart + i && activeInlineCell.colIdx === idx,
                            'editable-cell': editable && editable.enabled,
                            'cell-null': isCellNull(row, col, idx),
                            'cell-number': isCellNumber(row, col, idx),
                            'cell-search-match': cellMatchedSearch(row, col, idx)
                        }"
                        @contextmenu.prevent.stop="$emit('row-contextmenu', { event: $event, row, rowIndex: pageStart + i, column: col, columnIndex: idx })"
                        @dblclick="showCellDetail(row, col, idx, pageStart + i, idx, $event)">
                        <input v-if="row && row.__pendingInsert"
                               :value="getCellEditValue(row, col, idx)"
                               type="text"
                               class="cell-inline-input pending-cell-input"
                               placeholder="NULL"
                               @input="updatePendingCell(row, col, idx, $event)" />
                        <input v-else-if="activeInlineCell.rowIdx === pageStart + i && activeInlineCell.colIdx === idx"
                               :id="'inline-input-' + (pageStart + i) + '-' + idx"
                               type="text"
                               class="cell-inline-input"
                               v-model="inlineEditValue"
                               :readonly="!(editable && editable.enabled)"
                               @blur="closeInlineCell"
                               @keyup.enter="commitInlineCell(row, col, idx, pageStart + i, idx)"
                               @keyup.esc="closeInlineCell" />
                        <span v-else class="cell-text-span">{{ getCellDisplayValue(row, col, idx) }}</span>
                    </td>
                </tr>
            </tbody>
        </table>
    `
};
