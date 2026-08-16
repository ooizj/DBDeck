export default {
    inject: ['dbService'],
    props: {
        show: { type: Boolean, default: false },
        sourceId: { type: Number, required: true },
        table: { type: String, required: true },
        mode: { type: String, default: 'insert' }, // insert, edit, view
        editData: { type: Object, default: null },
        columns: { type: Array, default: () => [] },
        primaryKey: { type: String, default: null }
    },
    emits: ['close', 'saved'],
    data() {
        return {
            formData: {},
            loading: false,
            error: null,
            jsonMode: false,
            jsonText: ''
        };
    },
    computed: {
        title() {
            const titles = {
                insert: '新增行',
                edit: '编辑行',
                view: '查看行'
            };
            return titles[this.mode] || '数据编辑';
        },
        isReadonly() {
            return this.mode === 'view';
        }
    },
    watch: {
        show(val) {
            if (val) {
                this.initForm();
            }
        },
        editData: {
            handler(val) {
                if (val && this.show) {
                    this.initForm();
                }
            },
            deep: true
        }
    },
    methods: {
        initForm() {
            this.error = null;
            if (this.mode === 'insert') {
                this.formData = {};
                this.columns.forEach(col => {
                    this.formData[col.name] = col.default || '';
                });
            } else if (this.editData) {
                this.formData = { ...this.editData };
            }
            this.jsonText = JSON.stringify(this.formData, null, 2);
        },
        toggleJsonMode() {
            if (this.jsonMode) {
                try {
                    this.formData = JSON.parse(this.jsonText);
                    this.jsonMode = false;
                } catch (e) {
                    this.error = 'JSON 格式错误: ' + e.message;
                }
            } else {
                this.jsonText = JSON.stringify(this.formData, null, 2);
                this.jsonMode = true;
            }
        },
        updateJsonText() {
            try {
                this.formData = JSON.parse(this.jsonText);
                this.error = null;
            } catch (e) {
                this.error = 'JSON 格式错误';
            }
        },
        getColumnType(colName) {
            const col = this.columns.find(c => c.name === colName);
            if (!col) return 'text';
            const type = (col.type || '').toLowerCase();
            if (type.includes('int') || type.includes('float') || type.includes('decimal') || type.includes('number')) {
                return 'number';
            }
            if (type.includes('bool')) {
                return 'checkbox';
            }
            if (type.includes('date') || type.includes('time')) {
                return 'datetime';
            }
            if (type.includes('text') || type.includes('clob') || type.includes('long')) {
                return 'textarea';
            }
            return 'text';
        },
        isNumeric(colName) {
            return this.getColumnType(colName) === 'number';
        },
        async save() {
            if (this.isReadonly) return;

            this.loading = true;
            this.error = null;

            try {
                let result;
                if (this.mode === 'insert') {
                    result = await this.dbService.editData(
                        this.sourceId,
                        this.table,
                        'insert',
                        this.formData
                    );
                } else if (this.mode === 'edit') {
                    const where = {};
                    if (this.primaryKey) {
                        where[this.primaryKey] = this.editData[this.primaryKey];
                    } else {
                        // 使用所有原始值作为条件
                        Object.keys(this.editData).forEach(key => {
                            where[key] = this.editData[key];
                        });
                    }
                    result = await this.dbService.editData(
                        this.sourceId,
                        this.table,
                        'update',
                        this.formData,
                        where
                    );
                }

                if (result && result.success) {
                    this.$emit('saved');
                    this.$emit('close');
                } else {
                    this.error = result?.error || '操作失败';
                }
            } catch (e) {
                this.error = e.message || '操作失败';
            } finally {
                this.loading = false;
            }
        }
    },
    template: `
        <el-dialog
            :model-value="show"
            @update:model-value="$emit('close')"
            width="640px"
            destroy-on-close
            append-to-body
        >
            <template #header>
                <div style="display: flex; align-items: center; justify-content: space-between; width: 100%; padding-right: 24px;">
                    <span style="font-size: 16px; font-weight: 600;">{{ title }} - {{ table }}</span>
                    <el-button text size="small" @click="toggleJsonMode" :title="jsonMode ? '表单模式' : 'JSON模式'">
                        {{ jsonMode ? '📝 表单' : '{ } JSON' }}
                    </el-button>
                </div>
            </template>

            <div class="modal-body">
                <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" style="margin-bottom: 12px;" />

                <el-input
                    v-if="jsonMode"
                    type="textarea"
                    v-model="jsonText"
                    @input="updateJsonText"
                    :disabled="isReadonly"
                    :rows="15"
                    spellcheck="false"
                />

                <el-form v-else label-position="top">
                    <div class="form-grid">
                        <div v-for="col in columns" :key="col.name" class="form-field">
                            <label>
                                {{ col.name }}
                                <span v-if="col.key === 'PRI'" class="badge-pk">PK</span>
                                <span v-if="!col.nullable" class="required">*</span>
                            </label>

                            <el-checkbox
                                v-if="getColumnType(col.name) === 'checkbox'"
                                v-model="formData[col.name]"
                                :disabled="isReadonly"
                                :true-value="1"
                                :false-value="0"
                            >
                                {{ formData[col.name] ? '是' : '否' }}
                            </el-checkbox>

                            <el-input
                                v-else-if="getColumnType(col.name) === 'textarea'"
                                type="textarea"
                                v-model="formData[col.name]"
                                :disabled="isReadonly"
                                :rows="3"
                            />

                            <el-input
                                v-else
                                :type="getColumnType(col.name)"
                                v-model="formData[col.name]"
                                :disabled="isReadonly"
                                :class="{ numeric: isNumeric(col.name) }"
                            />

                            <small v-if="col.type" class="col-type">{{ col.type }}</small>
                        </div>
                    </div>
                </el-form>
            </div>

            <template #footer v-if="!isReadonly">
                <el-button @click="$emit('close')">取消</el-button>
                <el-button type="primary" @click="save" :loading="loading">{{ loading ? '保存中...' : '保存' }}</el-button>
            </template>
        </el-dialog>
    `
};
