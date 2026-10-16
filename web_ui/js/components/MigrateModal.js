export default {
    props: {
        show: Boolean,
        migrateSourceId: [String, Number],
        migrateDestId: [String, Number],
        migrateTables: Array,
        selectedMigrateTables: Array,
        sources: Array,
        tablesLoading: Boolean,
        tablesError: String,
    },
    emits: ['close', 'source-change', 'update:dest-id', 'update:selected-tables', 'do-migrate'],
    data() {
        return { tableFilter: '' };
    },
    computed: {
        filteredTables() {
            const q = this.tableFilter.trim().toLowerCase();
            if (!q) return this.migrateTables;
            return this.migrateTables.filter(t => t.name.toLowerCase().includes(q));
        },
        allFilteredSelected() {
            return this.filteredTables.length > 0
                && this.filteredTables.every(t => this.selectedMigrateTables.includes(t.name));
        },
    },
    watch: {
        migrateSourceId() {
            this.tableFilter = '';
        },
    },
    methods: {
        sourceLabel(s) {
            return s.database ? `${s.name}（${s.database}）` : s.name;
        },
        toggleAll(checked) {
            const names = this.filteredTables.map(t => t.name);
            const rest = this.selectedMigrateTables.filter(name => !names.includes(name));
            this.$emit('update:selected-tables', checked ? [...rest, ...names] : rest);
        },
        toggleTable(name, checked) {
            const updated = this.selectedMigrateTables.filter(t => t !== name);
            if (checked) updated.push(name);
            this.$emit('update:selected-tables', updated);
        },
    },
    template: `
        <el-dialog
            :model-value="show"
            @update:model-value="$emit('close')"
            title="数据迁移"
            width="680px"
            destroy-on-close
            append-to-body
        >
            <div class="migrate-body">
                <div class="migrate-endpoints">
                    <div class="migrate-endpoint">
                        <div class="migrate-label">源连接</div>
                        <el-select no-data-text="无数据" no-match-text="无匹配数据"
                            :model-value="migrateSourceId"
                            placeholder="选择源连接"
                            filterable
                            @update:model-value="(v) => $emit('source-change', v)"
                        >
                            <el-option v-for="s in sources" :key="s.id" :label="sourceLabel(s)" :value="s.id" />
                        </el-select>
                    </div>
                    <span class="migrate-arrow">→</span>
                    <div class="migrate-endpoint">
                        <div class="migrate-label">目标连接</div>
                        <el-select no-data-text="无数据" no-match-text="无匹配数据"
                            :model-value="migrateDestId"
                            placeholder="选择目标连接"
                            filterable
                            @update:model-value="(v) => $emit('update:dest-id', v)"
                        >
                            <el-option v-for="s in sources" :key="s.id" :label="sourceLabel(s)" :value="s.id" :disabled="s.id === migrateSourceId" />
                        </el-select>
                    </div>
                </div>
                <div class="field-hint">仅支持 MySQL、SQLite 之间按表复制结构和数据。目标库没有同名表时自动建表；已有同名表时直接追加数据。</div>

                <div class="migrate-tables">
                    <div v-if="!migrateSourceId" class="migrate-empty">先选择源连接</div>
                    <div v-else-if="tablesLoading" class="migrate-empty"><span class="spinner-small"></span> 正在读取表…</div>
                    <el-alert v-else-if="tablesError" :title="tablesError" type="error" show-icon :closable="false" />
                    <div v-else-if="!migrateTables.length" class="migrate-empty">该连接下没有表</div>
                    <template v-else>
                        <div class="migrate-tables-head">
                            <el-checkbox :model-value="allFilteredSelected" @change="toggleAll">全选</el-checkbox>
                            <el-input v-model="tableFilter" size="small" clearable placeholder="过滤表名" class="migrate-filter" />
                            <span class="migrate-count">已选 {{ selectedMigrateTables.length }} / {{ migrateTables.length }}</span>
                        </div>
                        <div class="migrate-table-list">
                            <el-checkbox
                                v-for="table in filteredTables" :key="table.name"
                                :model-value="selectedMigrateTables.includes(table.name)"
                                @change="(checked) => toggleTable(table.name, checked)"
                            >{{ table.name }}</el-checkbox>
                            <div v-if="!filteredTables.length" class="migrate-empty">没有匹配的表</div>
                        </div>
                    </template>
                </div>
            </div>

            <template #footer>
                <el-button @click="$emit('close')">取消</el-button>
                <el-button type="primary" @click="$emit('do-migrate')" :disabled="!migrateSourceId || !migrateDestId || selectedMigrateTables.length === 0">
                    开始迁移{{ selectedMigrateTables.length ? '（' + selectedMigrateTables.length + ' 张表）' : '' }}
                </el-button>
            </template>
        </el-dialog>
    `,
};
