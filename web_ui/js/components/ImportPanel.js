export default {
    props: ['sourceId', 'sources'],
    emits: ['close', 'imported'],
    data() {
        return {
            file: null,
            tableName: '',
            mode: 'create',
            importing: false,
            result: null,
        };
    },
    methods: {
        handleFileChange(e) {
            const files = e.target.files;
            if (files.length) {
                this.file = files[0];
                if (!this.tableName) {
                    this.tableName = this.file.name.replace(/\.[^.]+$/, '').replace(/[\s-]+/g, '_');
                }
            }
        },
        async doImport() {
            if (!this.file || !this.sourceId) return;
            this.importing = true;
            this.result = null;
            try {
                const res = await this.apiImport(this.file, this.sourceId, this.tableName, this.mode);
                this.result = res;
                if (res.success) {
                    this.$emit('imported');
                }
            } catch (e) {
                this.result = { success: false, error: e.message };
            } finally {
                this.importing = false;
            }
        },
        async apiImport(file, sourceId, tableName, mode) {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('source_id', sourceId);
            formData.append('table_name', tableName);
            formData.append('mode', mode);
            const response = await fetch('/api/import', { method: 'POST', body: formData });
            if (!response.ok) {
                const data = await response.json().catch(() => ({ detail: 'Import failed' }));
                throw new Error(data.detail || data.error || 'Import failed');
            }
            return response.json();
        }
    },
    computed: {
        targetSource() {
            return (this.sources || []).find(s => s.id === this.sourceId) || null;
        },
    },
    template: `
        <el-dialog
            :model-value="true"
            @update:model-value="$emit('close')"
            title="导入数据"
            width="520px"
            destroy-on-close
            append-to-body
        >
            <el-form label-position="top" class="import-form" @submit.prevent>
                <el-form-item label="目标连接">
                    <div class="import-target">{{ targetSource ? targetSource.name : '-' }}<small v-if="targetSource?.database">{{ targetSource.database }}</small></div>
                </el-form-item>
                <el-form-item label="数据文件">
                    <div class="import-file">
                        <el-button @click="$refs.fileInput.click()">选择文件…</el-button>
                        <span :class="['import-file-name', { empty: !file }]">{{ file ? file.name : '支持 CSV、Excel（.xlsx），第一行为列名' }}</span>
                        <input ref="fileInput" type="file" accept=".csv,.xlsx" @change="handleFileChange" style="display: none;">
                    </div>
                </el-form-item>
                <el-form-item label="导入方式">
                    <el-radio-group v-model="mode">
                        <el-radio value="create">新建表</el-radio>
                        <el-radio value="append">追加到已有表</el-radio>
                    </el-radio-group>
                    <div class="field-hint">{{ mode === 'create' ? '按文件内容推断列类型建表；表名已存在时会自动加上行数后缀。' : '列名需要与已有表的列一致。' }}</div>
                </el-form-item>
                <el-form-item label="表名">
                    <el-input v-model="tableName" placeholder="默认使用文件名" />
                </el-form-item>
            </el-form>

            <el-alert
                v-if="result"
                :title="result.success ? ('导入成功：表 ' + result.table_name + '，共 ' + result.rows_imported + ' 行') : result.error"
                :type="result.success ? 'success' : 'error'"
                show-icon
                :closable="false"
            />

            <template #footer>
                <el-button @click="$emit('close')">{{ result?.success ? '完成' : '取消' }}</el-button>
                <el-button type="primary" @click="doImport" :loading="importing" :disabled="!file">开始导入</el-button>
            </template>
        </el-dialog>
    `
};
