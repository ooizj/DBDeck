import { t } from '../i18n/index.js';

export default {
    props: {
        show: Boolean,
        systemConfig: Object,
        isLoading: Boolean,
        locale: String,                     // 当前实际使用的语言
        localeMode: { type: String, default: 'system' }, // 'system' / 'zh' / 'en'
        locales: { type: Array, default: () => [] },
    },
    emits: ['close', 'save', 'change-locale', 'export-config', 'import-config', 'import-dbeaver-config', 'import-dbeaver-file'],
    data() {
        return { activeTab: 'general' };
    },
    computed: {
        currentLocaleLabel() {
            return this.locales.find(item => item.id === this.locale)?.label || this.locale;
        },
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
                        ElementPlus.ElMessage.error(t('settings.invalidConfigFile'));
                        return;
                    }
                    this.$emit('import-config', parsed);
                } catch (err) {
                    ElementPlus.ElMessage.error(t('settings.invalidJson', { error: err.message }));
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
            :title="$t('toolbar.settings')"
            width="600px"
            destroy-on-close
            append-to-body
            class="settings-dialog"
        >
            <el-tabs v-model="activeTab" class="settings-tabs">
                <el-tab-pane :label="$t('settings.generalTab')" name="general">
                    <el-form label-position="top" class="settings-form" @submit.prevent>
                        <el-form-item :label="$t('settings.language')">
                            <div class="settings-language">
                            <el-radio-group :model-value="localeMode" @update:model-value="(v) => $emit('change-locale', v)">
                                <el-radio-button value="system">{{ $t('settings.languageSystem') }}</el-radio-button>
                                <el-radio-button v-for="item in locales" :key="item.id" :value="item.id">{{ item.label }}</el-radio-button>
                            </el-radio-group>
                            <div class="field-hint">
                                {{ localeMode === 'system' ? $t('settings.languageSystemHint', { language: currentLocaleLabel }) : $t('settings.languageHint') }}
                            </div>
                            </div>
                        </el-form-item>
                    </el-form>
                </el-tab-pane>
                <el-tab-pane :label="$t('settings.aiTab')" name="llm">
                    <el-form label-position="top" class="settings-form" @submit.prevent>
                        <el-form-item label="API Key">
                            <el-input type="password" v-model="systemConfig.LLM_API_KEY" placeholder="sk-..." show-password />
                        </el-form-item>
                        <el-form-item :label="$t('settings.apiBase')">
                            <el-input v-model="systemConfig.LLM_API_BASE" placeholder="https://api.openai.com/v1" />
                            <div class="field-hint">{{ $t('settings.apiBaseHint') }}</div>
                        </el-form-item>
                        <el-form-item :label="$t('settings.model')">
                            <el-input v-model="systemConfig.LLM_MODEL" :placeholder="$t('field.example', { value: 'gpt-4o' })" />
                        </el-form-item>
                        <div class="settings-grid">
                            <el-form-item label="Temperature">
                                <el-input-number v-model="systemConfig.LLM_TEMPERATURE" :step="0.1" :min="0" :max="1" :precision="1" controls-position="right" />
                                <div class="field-hint">{{ $t('settings.temperatureHint') }}</div>
                            </el-form-item>
                            <el-form-item :label="$t('settings.maxTokens')">
                                <el-input-number v-model="systemConfig.LLM_MAX_TOKENS" :step="256" :min="256" controls-position="right" placeholder="8192" />
                                <div class="field-hint">{{ $t('settings.maxTokensHint') }}</div>
                            </el-form-item>
                        </div>
                    </el-form>
                </el-tab-pane>
                <el-tab-pane :label="$t('settings.dataTab')" name="data">
                    <div class="settings-actions">
                        <div class="settings-action">
                            <div>
                                <div class="settings-action-title">{{ $t('settings.exportTitle') }}</div>
                                <div class="settings-action-desc">{{ $t('settings.exportDesc') }}</div>
                            </div>
                            <el-button @click="$emit('export-config')" :loading="isLoading">{{ $t('settings.exportButton') }}</el-button>
                        </div>
                        <div class="settings-action">
                            <div>
                                <div class="settings-action-title">{{ $t('settings.importTitle') }}</div>
                                <div class="settings-action-desc">{{ $t('settings.importDesc') }}</div>
                            </div>
                            <el-button @click="triggerImport" :loading="isLoading">{{ $t('settings.chooseFile') }}</el-button>
                        </div>
                        <div class="settings-action">
                            <div>
                                <div class="settings-action-title">{{ $t('settings.dbeaverTitle') }}</div>
                                <div class="settings-action-desc">{{ $t('settings.dbeaverDesc') }}</div>
                            </div>
                            <el-button @click="handleDbeaverImportClick" :loading="isLoading">{{ $t('settings.chooseFile') }}</el-button>
                        </div>
                    </div>
                    <input type="file" ref="importFileInput" style="display: none;" accept=".json" @change="handleFileImport">
                    <input type="file" ref="dbeaverFileInput" style="display: none;" accept=".dbp,.zip,.json" @change="handleDbeaverFileImport">
                </el-tab-pane>
            </el-tabs>

            <template #footer>
                <template v-if="activeTab === 'llm'">
                    <el-button @click="$emit('close')" :disabled="isLoading">{{ $t('common.cancel') }}</el-button>
                    <el-button type="primary" @click="$emit('save')" :loading="isLoading">{{ $t('common.save') }}</el-button>
                </template>
                <el-button v-else @click="$emit('close')">{{ $t('common.close') }}</el-button>
            </template>
        </el-dialog>
    `,
};
