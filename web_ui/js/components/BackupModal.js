import { t } from '../i18n/index.js';

export default {
    inject: ['dbService'],
    props: {
        show: { type: Boolean, default: false },
        sourceId: { type: Number, required: true },
        sourceName: { type: String, default: '' },
        tables: { type: Array, default: () => [] }
    },
    emits: ['close'],
    data() {
        return {
            selectedTables: [],
            includeStructure: true,
            includeData: true,
            loading: false,
            error: null,
            backupResult: null,
            savedPath: '',
            mode: 'backup' // backup, export
        };
    },
    computed: {
        title() {
            return this.mode === 'backup' ? t('menu.backupDatabase') : t('backup.exportData');
        }
    },
    watch: {
        // 弹框通过 v-if 挂载时 show 一开始就是 true，需要 immediate 才能默认全选
        show: {
            immediate: true,
            handler(val) {
                if (val) {
                    this.selectedTables = [...this.tables];
                    this.backupResult = null;
                    this.savedPath = '';
                    this.error = null;
                }
            },
        },
    },
    methods: {
        toggleTable(table) {
            const idx = this.selectedTables.indexOf(table);
            if (idx === -1) {
                this.selectedTables.push(table);
            } else {
                this.selectedTables.splice(idx, 1);
            }
        },
        selectAll() {
            this.selectedTables = [...this.tables];
        },
        deselectAll() {
            this.selectedTables = [];
        },
        async startBackup() {
            if (!this.selectedTables.length) {
                this.error = t('backup.needTable');
                return;
            }
            if (!this.includeStructure && !this.includeData) {
                this.error = t('backup.needContent');
                return;
            }

            this.loading = true;
            this.error = null;

            try {
                const result = await this.dbService.backupDatabase(
                    this.sourceId,
                    this.selectedTables,
                    this.includeStructure,
                    this.includeData
                );

                if (result.success) {
                    this.backupResult = result;
                    this.savedPath = '';
                } else {
                    this.error = result.error || t('backup.failed');
                }
            } catch (e) {
                this.error = e.message || t('backup.failed');
            } finally {
                this.loading = false;
            }
        },
        async downloadBackup() {
            if (!this.backupResult) return;

            const safeName = (this.sourceName || 'database').replace(/[\\/:*?"<>|]/g, '_');
            const filename = `${safeName}_${new Date().toISOString().slice(0, 10)}.sql`;
            const nativeSave = window.pywebview?.api?.save_file;
            if (nativeSave) {
                try {
                    const result = await nativeSave(filename, this.backupResult.content, 'sql|txt');
                    if (result?.success) {
                        this.savedPath = result.path;
                    } else if (!result?.cancelled) {
                        this.error = result?.error || t('backup.saveFailed');
                    }
                } catch (e) {
                    this.error = e.message || t('backup.saveFailed');
                }
                return;
            }

            const blob = new Blob([this.backupResult.content], { type: 'text/sql' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
            this.savedPath = t('backup.browserDownload');
        },
        copyToClipboard() {
            if (!this.backupResult) return;
            navigator.clipboard.writeText(this.backupResult.content).then(() => {
                ElementPlus.ElMessage.success(t('common.copied'));
            });
        }
    },
    template: `
        <el-dialog
            :model-value="show"
            @update:model-value="$emit('close')"
            :title="title + ' - ' + sourceName"
            width="600px"
            destroy-on-close
            append-to-body
        >
            <div class="modal-body">
                <div v-if="error" class="error-message">{{ error }}</div>

                <div v-if="!backupResult">
                    <div class="backup-options">
                        <el-checkbox v-model="includeStructure">{{ $t('backup.includeStructure') }}</el-checkbox>
                        <el-checkbox v-model="includeData">{{ $t('backup.includeData') }}</el-checkbox>
                    </div>

                    <div class="table-selector">
                        <div class="selector-header">
                            <h4>{{ $t('backup.selectTables') }}</h4>
                            <div class="selector-actions">
                                <el-button size="small" @click="selectAll">{{ $t('common.selectAll') }}</el-button>
                                <el-button size="small" @click="deselectAll">{{ $t('common.deselectAll') }}</el-button>
                            </div>
                        </div>

                        <div class="table-list">
                            <el-checkbox
                                v-for="table in tables"
                                :key="table"
                                :model-value="selectedTables.includes(table)"
                                @change="toggleTable(table)"
                                class="table-item"
                            >
                                {{ table }}
                            </el-checkbox>
                        </div>

                        <div class="selected-count">
                            {{ $t('backup.selectedCount', { selected: selectedTables.length, total: tables.length }) }}
                        </div>
                    </div>
                </div>

                <div v-else class="backup-result">
                    <div class="result-info">
                        <p>{{ $t('backup.generated') }}</p>
                        <p>{{ $t('backup.tableCount', { count: backupResult.tables.length }) }}</p>
                        <p>{{ $t('backup.fileSize', { size: (backupResult.size / 1024).toFixed(2) }) }}</p>
                        <p v-if="savedPath">{{ $t('backup.savedPath', { path: savedPath }) }}</p>
                    </div>

                    <div class="result-preview">
                        <h4>{{ $t('backup.preview') }}</h4>
                        <pre>{{ backupResult.content.substring(0, 1000) }}{{ backupResult.content.length > 1000 ? '\\n...' : '' }}</pre>
                    </div>
                </div>
            </div>

            <template #footer>
                <el-button @click="$emit('close')">{{ $t('common.close') }}</el-button>
                <el-button v-if="!backupResult" type="primary" :loading="loading" :disabled="!selectedTables.length || (!includeStructure && !includeData)" @click="startBackup">
                    {{ loading ? $t('backup.running') : $t('backup.start') }}
                </el-button>
                <template v-else>
                    <el-button @click="copyToClipboard">{{ $t('common.copy') }}</el-button>
                    <el-button type="primary" @click="downloadBackup">{{ $t('backup.saveSql') }}</el-button>
                </template>
            </template>
        </el-dialog>
    `
};
