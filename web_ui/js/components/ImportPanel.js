import { languageHeaders } from '../api.js';
import { t } from '../i18n/index.js';

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
            const response = await fetch('/api/import', { method: 'POST', body: formData, headers: languageHeaders() });
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                throw new Error(data.detail || data.error || t('import.failed'));
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
            :title="$t('menu.importData')"
            width="520px"
            destroy-on-close
            append-to-body
        >
            <el-form label-position="top" class="import-form" @submit.prevent>
                <el-form-item :label="$t('migrate.target')">
                    <div class="import-target">{{ targetSource ? targetSource.name : '-' }}<small v-if="targetSource?.database">{{ targetSource.database }}</small></div>
                </el-form-item>
                <el-form-item :label="$t('import.file')">
                    <div class="import-file">
                        <el-button @click="$refs.fileInput.click()">{{ $t('settings.chooseFile') }}</el-button>
                        <span :class="['import-file-name', { empty: !file }]">{{ file ? file.name : $t('import.fileHint') }}</span>
                        <input ref="fileInput" type="file" accept=".csv,.xlsx" @change="handleFileChange" style="display: none;">
                    </div>
                </el-form-item>
                <el-form-item :label="$t('import.mode')">
                    <el-radio-group v-model="mode">
                        <el-radio value="create">{{ $t('import.modeCreate') }}</el-radio>
                        <el-radio value="append">{{ $t('import.modeAppend') }}</el-radio>
                    </el-radio-group>
                    <div class="field-hint">{{ mode === 'create' ? $t('import.modeCreateHint') : $t('import.modeAppendHint') }}</div>
                </el-form-item>
                <el-form-item :label="$t('import.tableName')">
                    <el-input v-model="tableName" :placeholder="$t('import.tableNamePlaceholder')" />
                </el-form-item>
            </el-form>

            <el-alert
                v-if="result"
                :title="result.success ? $t('import.success', { table: result.table_name, rows: result.rows_imported }) : result.error"
                :type="result.success ? 'success' : 'error'"
                show-icon
                :closable="false"
            />

            <template #footer>
                <el-button @click="$emit('close')">{{ result?.success ? $t('common.done') : $t('common.cancel') }}</el-button>
                <el-button type="primary" @click="doImport" :loading="importing" :disabled="!file">{{ $t('import.start') }}</el-button>
            </template>
        </el-dialog>
    `
};
