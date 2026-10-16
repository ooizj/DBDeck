export default {
    props: {
        show: Boolean,
        systemConfig: Object,
        isLoading: Boolean,
    },
    emits: ['close', 'save', 'export-config', 'import-config', 'import-dbeaver-config', 'import-dbeaver-file'],
    data() {
        return { activeTab: 'llm' };
    },
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
            title="设置"
            width="600px"
            destroy-on-close
            append-to-body
            class="settings-dialog"
        >
            <el-tabs v-model="activeTab" class="settings-tabs">
                <el-tab-pane label="AI 模型" name="llm">
                    <el-form label-position="top" class="settings-form" @submit.prevent>
                        <el-form-item label="API Key">
                            <el-input type="password" v-model="systemConfig.LLM_API_KEY" placeholder="sk-..." show-password />
                        </el-form-item>
                        <el-form-item label="API 地址（Base URL）">
                            <el-input v-model="systemConfig.LLM_API_BASE" placeholder="https://api.openai.com/v1" />
                            <div class="field-hint">兼容 OpenAI 接口的服务地址。</div>
                        </el-form-item>
                        <el-form-item label="模型名称">
                            <el-input v-model="systemConfig.LLM_MODEL" placeholder="例如：gpt-4o" />
                        </el-form-item>
                        <div class="settings-grid">
                            <el-form-item label="Temperature">
                                <el-input-number v-model="systemConfig.LLM_TEMPERATURE" :step="0.1" :min="0" :max="1" :precision="1" controls-position="right" />
                                <div class="field-hint">0 ~ 1，越低回答越稳定。</div>
                            </el-form-item>
                            <el-form-item label="单次最大输出 Token">
                                <el-input-number v-model="systemConfig.LLM_MAX_TOKENS" :step="256" :min="256" controls-position="right" placeholder="8192" />
                                <div class="field-hint">防止模型陷入循环无限输出。</div>
                            </el-form-item>
                        </div>
                    </el-form>
                </el-tab-pane>
                <el-tab-pane label="导入 / 导出" name="data">
                    <div class="settings-actions">
                        <div class="settings-action">
                            <div>
                                <div class="settings-action-title">导出配置与连接</div>
                                <div class="settings-action-desc">保存为 JSON 文件，包含全部连接（含密码）和 AI 设置，可在其他电脑导入。请妥善保管。</div>
                            </div>
                            <el-button @click="$emit('export-config')" :loading="isLoading">导出…</el-button>
                        </div>
                        <div class="settings-action">
                            <div>
                                <div class="settings-action-title">导入配置与连接</div>
                                <div class="settings-action-desc">从导出的 JSON 文件导入；已存在的同名同地址连接会跳过，AI 设置会被覆盖。</div>
                            </div>
                            <el-button @click="triggerImport" :loading="isLoading">选择文件…</el-button>
                        </div>
                        <div class="settings-action">
                            <div>
                                <div class="settings-action-title">从 DBeaver 导入连接</div>
                                <div class="settings-action-desc">支持 data-sources.json、.dbp 或 .zip 工程文件，只导入 DBDeck 支持的数据库类型。</div>
                            </div>
                            <el-button @click="handleDbeaverImportClick" :loading="isLoading">选择文件…</el-button>
                        </div>
                    </div>
                    <input type="file" ref="importFileInput" style="display: none;" accept=".json" @change="handleFileImport">
                    <input type="file" ref="dbeaverFileInput" style="display: none;" accept=".dbp,.zip,.json" @change="handleDbeaverFileImport">
                </el-tab-pane>
            </el-tabs>

            <template #footer>
                <template v-if="activeTab === 'llm'">
                    <el-button @click="$emit('close')" :disabled="isLoading">取消</el-button>
                    <el-button type="primary" @click="$emit('save')" :loading="isLoading">保存</el-button>
                </template>
                <el-button v-else @click="$emit('close')">关闭</el-button>
            </template>
        </el-dialog>
    `,
};
