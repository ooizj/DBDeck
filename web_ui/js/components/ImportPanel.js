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
    template: `
        <el-dialog
            :model-value="true"
            @update:model-value="$emit('close')"
            title="导入数据"
            width="480px"
            destroy-on-close
            append-to-body
        >
            <el-form label-position="top">
                <el-form-item label="选择文件 (CSV / Excel)">
                    <input type="file" accept=".csv,.xlsx,.xls" @change="handleFileChange" style="width: 100%;">
                </el-form-item>
                <el-form-item label="表名">
                    <el-input v-model="tableName" placeholder="导入到的目标表名" />
                </el-form-item>
                <el-form-item label="模式">
                    <el-select v-model="mode" style="width: 100%;">
                        <el-option value="create" label="创建新表" />
                        <el-option value="append" label="追加到已有表" />
                    </el-select>
                </el-form-item>
            </el-form>

            <el-alert
                v-if="result"
                :title="result.success ? ('导入成功! 表: ' + result.table_name + ', 行数: ' + result.rows_imported) : result.error"
                :type="result.success ? 'success' : 'error'"
                show-icon
                :closable="false"
                style="margin-top: 8px;"
            />

            <template #footer>
                <el-button @click="$emit('close')">取消</el-button>
                <el-button type="primary" @click="doImport" :loading="importing" :disabled="!file">
                    {{ importing ? '导入中...' : '开始导入' }}
                </el-button>
            </template>
        </el-dialog>
    `
};
