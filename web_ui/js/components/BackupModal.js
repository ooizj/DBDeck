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
            return this.mode === 'backup' ? '备份数据库' : '导出数据';
        }
    },
    watch: {
        show(val) {
            if (val) {
                this.selectedTables = [...this.tables];
                this.backupResult = null;
                this.savedPath = '';
                this.error = null;
            }
        }
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
                this.error = '请选择至少一个表';
                return;
            }
            if (!this.includeStructure && !this.includeData) {
                this.error = '请至少选择表结构或数据中的一项';
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
                    this.error = result.error || '备份失败';
                }
            } catch (e) {
                this.error = e.message || '备份失败';
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
                        this.error = result?.error || '保存备份文件失败';
                    }
                } catch (e) {
                    this.error = e.message || '保存备份文件失败';
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
            this.savedPath = '已提交到浏览器下载目录';
        },
        copyToClipboard() {
            if (!this.backupResult) return;
            navigator.clipboard.writeText(this.backupResult.content).then(() => {
                ElementPlus.ElMessage.success('已复制到剪贴板');
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
                        <el-checkbox v-model="includeStructure">包含表结构</el-checkbox>
                        <el-checkbox v-model="includeData">包含数据</el-checkbox>
                    </div>

                    <div class="table-selector">
                        <div class="selector-header">
                            <h4>选择表</h4>
                            <div class="selector-actions">
                                <el-button size="small" @click="selectAll">全选</el-button>
                                <el-button size="small" @click="deselectAll">取消全选</el-button>
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
                            已选择 {{ selectedTables.length }} / {{ tables.length }} 个表
                        </div>
                    </div>
                </div>

                <div v-else class="backup-result">
                    <div class="result-info">
                        <p>备份内容已生成（尚未保存到磁盘）</p>
                        <p>表数量: {{ backupResult.tables.length }}</p>
                        <p>文件大小: {{ (backupResult.size / 1024).toFixed(2) }} KB</p>
                        <p v-if="savedPath">保存位置: {{ savedPath }}</p>
                    </div>

                    <div class="result-preview">
                        <h4>预览</h4>
                        <pre>{{ backupResult.content.substring(0, 1000) }}{{ backupResult.content.length > 1000 ? '\\n...' : '' }}</pre>
                    </div>
                </div>
            </div>

            <template #footer>
                <el-button @click="$emit('close')">关闭</el-button>
                <el-button v-if="!backupResult" type="primary" :loading="loading" :disabled="!selectedTables.length || (!includeStructure && !includeData)" @click="startBackup">
                    {{ loading ? '备份中...' : '开始备份' }}
                </el-button>
                <template v-else>
                    <el-button @click="copyToClipboard">复制</el-button>
                    <el-button type="primary" @click="downloadBackup">下载 SQL 文件</el-button>
                </template>
            </template>
        </el-dialog>
    `
};
