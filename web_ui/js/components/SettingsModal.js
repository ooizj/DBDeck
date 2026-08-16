export default {
    props: {
        show: Boolean,
        systemConfig: Object,
        isLoading: Boolean,
    },
    emits: ['close', 'save', 'export-config', 'import-config', 'import-dbeaver-config', 'import-dbeaver-file'],
    methods: {
        triggerImport() {
            this.$refs.importFileInput.click();
        },
        triggerDbeaverImport() {
            this.$refs.dbeaverFileInput.click();
        },
        hasPywebviewApi(name) {
            return Boolean(globalThis.pywebview?.api?.[name]);
        },
        handleDbeaverImportClick() {
            if (this.hasPywebviewApi('import_dbeaver_file')) {
                this.$emit('import-dbeaver-file');
                return;
            }
            this.triggerDbeaverImport();
        },
        handleFileImport(e) {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const parsed = JSON.parse(event.target.result);
                    if (!parsed.data_sources || !parsed.system_config) {
                        ElementPlus.ElMessage.error('无效的备份文件结构！必须包含 data_sources 和 system_config');
                        return;
                    }
                    this.$emit('import-config', parsed);
                } catch (err) {
                    ElementPlus.ElMessage.error('文件解析失败，请确保是合法的 JSON 格式文件：' + err.message);
                } finally {
                    e.target.value = '';
                }
            };
            reader.readAsText(file);
        },
        handleDbeaverFileImport(e) {
            const file = e.target.files[0];
            if (!file) return;
            this.$emit('import-dbeaver-config', file);
            e.target.value = '';
        },
    },
    template: `
        <el-dialog
            :model-value="show"
            @update:model-value="$emit('close')"
            title="系统设置 (LLM 配置)"
            width="560px"
            destroy-on-close
            append-to-body
        >
            <el-form label-position="top">
                <el-form-item label="LLM API Key">
                    <el-input type="password" v-model="systemConfig.LLM_API_KEY" placeholder="sk-..." show-password />
                </el-form-item>
                <el-form-item label="LLM API Base URL">
                    <el-input v-model="systemConfig.LLM_API_BASE" placeholder="https://api.openai.com/v1" />
                </el-form-item>
                <el-form-item label="LLM Model">
                    <el-input v-model="systemConfig.LLM_MODEL" placeholder="gpt-4-turbo" />
                </el-form-item>
                <el-form-item label="Temperature (0.0 - 1.0)">
                    <el-input-number v-model="systemConfig.LLM_TEMPERATURE" :step="0.1" :min="0" :max="1" controls-position="right" style="width: 100%;" />
                </el-form-item>
                <el-form-item label="Max Tokens（单次最大输出长度，防止思考死循环无限输出）">
                    <el-input-number v-model="systemConfig.LLM_MAX_TOKENS" :step="256" :min="256" controls-position="right" style="width: 100%;" placeholder="8192" />
                </el-form-item>
            </el-form>

            <div style="margin-top: 8px; padding-top: 16px; border-top: 1px solid var(--el-border-color-lighter);">
                <div style="font-weight: 500; font-size: 12px; margin-bottom: 10px; color: var(--el-text-color-secondary);">数据备份与迁移</div>
                <div style="display: grid; grid-template-columns: 48px 1fr 1fr; gap: 10px; align-items: center;">
                    <span style="font-size: 12px; color: var(--el-text-color-regular);">导出：</span>
                    <el-button style="grid-column: 2 / -1; width: 100%; margin-left: 0;" @click="$emit('export-config')">导出配置与连接</el-button>
                    <span style="font-size: 12px; color: var(--el-text-color-regular);">导入：</span>
                    <el-button style="width: 100%; margin-left: 0;" @click="triggerImport">导入配置与连接</el-button>
                    <el-button style="width: 100%; margin-left: 0;" @click="handleDbeaverImportClick">从dbeaver导入</el-button>
                </div>
                <input type="file" ref="importFileInput" style="display: none;" accept=".json" @change="handleFileImport">
                <input type="file" ref="dbeaverFileInput" style="display: none;" accept=".dbp,.zip,.json" @change="handleDbeaverFileImport">
            </div>

            <template #footer>
                <el-button @click="$emit('close')" :disabled="isLoading">取消</el-button>
                <el-button type="primary" @click="$emit('save')" :loading="isLoading">
                    {{ isLoading ? '保存中...' : '保存' }}
                </el-button>
            </template>
        </el-dialog>
    `,
};
