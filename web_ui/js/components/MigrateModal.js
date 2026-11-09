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
            return s.database ? `${s.name} (${s.database})` : s.name;
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
            :title="$t('migrate.title')"
            width="680px"
            destroy-on-close
            append-to-body
        >
            <div class="migrate-body">
                <div class="migrate-endpoints">
                    <div class="migrate-endpoint">
                        <div class="migrate-label">{{ $t('migrate.source') }}</div>
                        <el-select
                            :model-value="migrateSourceId"
                            :placeholder="$t('migrate.sourcePlaceholder')"
                            filterable
                            @update:model-value="(v) => $emit('source-change', v)"
                        >
                            <el-option v-for="s in sources" :key="s.id" :label="sourceLabel(s)" :value="s.id" />
                        </el-select>
                    </div>
                    <span class="migrate-arrow">→</span>
                    <div class="migrate-endpoint">
                        <div class="migrate-label">{{ $t('migrate.target') }}</div>
                        <el-select
                            :model-value="migrateDestId"
                            :placeholder="$t('migrate.targetPlaceholder')"
                            filterable
                            @update:model-value="(v) => $emit('update:dest-id', v)"
                        >
                            <el-option v-for="s in sources" :key="s.id" :label="sourceLabel(s)" :value="s.id" :disabled="s.id === migrateSourceId" />
                        </el-select>
                    </div>
                </div>
                <div class="field-hint">{{ $t('migrate.hint') }}</div>

                <div class="migrate-tables">
                    <div v-if="!migrateSourceId" class="migrate-empty">{{ $t('migrate.pickSource') }}</div>
                    <div v-else-if="tablesLoading" class="migrate-empty"><span class="spinner-small"></span> {{ $t('migrate.loadingTables') }}</div>
                    <el-alert v-else-if="tablesError" :title="tablesError" type="error" show-icon :closable="false" />
                    <div v-else-if="!migrateTables.length" class="migrate-empty">{{ $t('migrate.noTables') }}</div>
                    <template v-else>
                        <div class="migrate-tables-head">
                            <el-checkbox :model-value="allFilteredSelected" @change="toggleAll">{{ $t('common.selectAll') }}</el-checkbox>
                            <el-input v-model="tableFilter" size="small" clearable :placeholder="$t('migrate.filterPlaceholder')" class="migrate-filter" />
                            <span class="migrate-count">{{ $t('migrate.selectedCount', { selected: selectedMigrateTables.length, total: migrateTables.length }) }}</span>
                        </div>
                        <div class="migrate-table-list">
                            <el-checkbox
                                v-for="table in filteredTables" :key="table.name"
                                :model-value="selectedMigrateTables.includes(table.name)"
                                @change="(checked) => toggleTable(table.name, checked)"
                            >{{ table.name }}</el-checkbox>
                            <div v-if="!filteredTables.length" class="migrate-empty">{{ $t('migrate.noMatch') }}</div>
                        </div>
                    </template>
                </div>
            </div>

            <template #footer>
                <el-button @click="$emit('close')">{{ $t('common.cancel') }}</el-button>
                <el-button type="primary" @click="$emit('do-migrate')" :disabled="!migrateSourceId || !migrateDestId || selectedMigrateTables.length === 0">
                    {{ selectedMigrateTables.length ? $t('migrate.startWithCount', { count: selectedMigrateTables.length }) : $t('migrate.start') }}
                </el-button>
            </template>
        </el-dialog>
    `,
};
