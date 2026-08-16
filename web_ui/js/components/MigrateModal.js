export default {
    props: {
        show: Boolean,
        migrateSourceId: [String, Number],
        migrateDestId: [String, Number],
        migrateTables: Array,
        selectedMigrateTables: Array,
        sources: Array,
    },
    emits: ['close', 'source-change', 'update:dest-id', 'update:selected-tables', 'do-migrate'],
    template: `
        <el-dialog
            :model-value="show"
            @update:model-value="$emit('close')"
            title="数据迁移"
            width="760px"
            destroy-on-close
            append-to-body
        >
            <el-form label-position="top">
                <el-form-item label="源数据源">
                    <el-select
                        :model-value="migrateSourceId"
                        placeholder="请选择源..."
                        style="width: 100%;"
                        @update:model-value="(v) => $emit('source-change', v)"
                    >
                        <el-option v-for="s in sources" :key="s.id" :label="s.name + ' (' + s.database + ')'" :value="s.id" />
                    </el-select>
                </el-form-item>
                <el-form-item label="目标数据源">
                    <el-select
                        :model-value="migrateDestId"
                        placeholder="请选择目标..."
                        style="width: 100%;"
                        @update:model-value="(v) => $emit('update:dest-id', v)"
                    >
                        <el-option v-for="s in sources" :key="s.id" :label="s.name + ' (' + s.database + ')'" :value="s.id" :disabled="s.id === migrateSourceId" />
                    </el-select>
                </el-form-item>
                <el-form-item v-if="migrateSourceId" label="选择要迁移的表">
                    <div v-if="migrateTables.length > 0" class="migrate-table-picker">
                        <div class="migrate-table-picker-head">
                            <el-checkbox
                                :model-value="selectedMigrateTables.length === migrateTables.length && migrateTables.length > 0"
                                @change="(checked) => $emit('update:selected-tables', checked ? migrateTables.map(t => t.name) : [])"
                            >全选</el-checkbox>
                            <span>已选 {{ selectedMigrateTables.length }} / {{ migrateTables.length }}</span>
                        </div>
                        <div class="migrate-tree">
                            <div v-for="table in migrateTables" :key="table.name" class="migrate-table-item">
                                <el-checkbox
                                    :model-value="selectedMigrateTables.includes(table.name)"
                                    @change="(checked) => {
                                        let updated = [...selectedMigrateTables];
                                        if (checked) updated.push(table.name);
                                        else updated = updated.filter(t => t !== table.name);
                                        $emit('update:selected-tables', updated);
                                    }"
                                >{{ table.name }}</el-checkbox>
                            </div>
                        </div>
                    </div>
                    <div v-else class="migrate-empty">该数据源暂无表</div>
                </el-form-item>
            </el-form>

            <template #footer>
                <el-button @click="$emit('close')">取消</el-button>
                <el-button type="primary" @click="$emit('do-migrate')" :disabled="!migrateSourceId || !migrateDestId || selectedMigrateTables.length === 0">开始迁移</el-button>
            </template>
        </el-dialog>
    `,
};
