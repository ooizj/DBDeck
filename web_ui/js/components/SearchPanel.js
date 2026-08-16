export default {
    inject: ['dbService'],
    props: {
        show: { type: Boolean, default: false },
        sourceId: { type: Number, default: null },
        tables: { type: Array, default: () => [] }
    },
    emits: ['close', 'select'],
    data() {
        return {
            searchQuery: '',
            searchType: 'metadata', // metadata, data, fulltext
            selectedTable: null,
            selectedColumns: [],
            searchResults: [],
            loading: false,
            error: null,
            resultCount: 0,
            searchedTables: 0
        };
    },
    computed: {
        placeholder() {
            if (this.searchType === 'metadata') return '搜索表名、列名...';
            if (this.searchType === 'data') return '在表中搜索数据...';
            return '全文搜索...';
        }
    },
    watch: {
        show(val) {
            if (val) {
                this.searchQuery = '';
                this.searchResults = [];
                this.error = null;
            }
        }
    },
    methods: {
        async doSearch() {
            if (!this.searchQuery.trim() || !this.sourceId) return;

            this.loading = true;
            this.error = null;
            this.searchResults = [];

            try {
                let result;

                if (this.searchType === 'metadata') {
                    result = await this.dbService.searchMetadata(this.sourceId, this.searchQuery);
                } else if (this.searchType === 'data') {
                    if (!this.selectedTable) {
                        this.error = '请选择要搜索的表';
                        this.loading = false;
                        return;
                    }
                    result = await this.dbService.searchData(
                        this.sourceId,
                        this.selectedTable,
                        this.searchQuery,
                        this.selectedColumns.length ? this.selectedColumns.join(',') : null
                    );
                } else {
                    result = await this.dbService.fullTextSearch(
                        this.sourceId,
                        this.searchQuery,
                        this.selectedTable ? this.selectedTable : null
                    );
                }

                if (result.success) {
                    this.searchResults = result.results || [];
                    this.resultCount = result.count || this.searchResults.length;
                    this.searchedTables = result.tables_searched || 0;
                } else {
                    this.error = result.error || '搜索失败';
                }
            } catch (e) {
                this.error = e.message || '搜索失败';
            } finally {
                this.loading = false;
            }
        },
        handleKeydown(e) {
            if (e.key === 'Enter') {
                this.doSearch();
            }
        },
        selectResult(result) {
            this.$emit('select', result);
            this.$emit('close');
        },
        formatResult(result) {
            if (this.searchType === 'metadata') {
                return `${result.type === 'table' ? '📊' : '📋'} ${result.name}${result.table ? ` (${result.table})` : ''}`;
            }
            if (result.table) {
                return `📄 ${result.table}`;
            }
            return JSON.stringify(result.data || result).substring(0, 100);
        }
    },
    template: `
        <el-drawer
            :model-value="show"
            @update:model-value="$emit('close')"
            title="搜索"
            direction="rtl"
            size="520px"
            destroy-on-close
        >
            <div class="modal-body">
                <div class="search-toolbar">
                    <el-radio-group v-model="searchType" size="small" @change="searchResults = []">
                        <el-radio-button label="metadata">元数据</el-radio-button>
                        <el-radio-button label="data">数据</el-radio-button>
                        <el-radio-button label="fulltext">全文</el-radio-button>
                    </el-radio-group>

                    <div class="search-input-wrapper" style="display: flex; gap: 8px; margin-top: 12px;">
                        <el-input
                            v-model="searchQuery"
                            :placeholder="placeholder"
                            @keydown="handleKeydown"
                        />
                        <el-button type="primary" @click="doSearch" :loading="loading">
                            {{ loading ? '搜索中...' : '搜索' }}
                        </el-button>
                    </div>

                    <div v-if="searchType !== 'metadata'" class="search-options" style="margin-top: 12px;">
                        <div class="option-field" style="display: flex; align-items: center; gap: 8px;">
                            <label>表：</label>
                            <el-select v-model="selectedTable" placeholder="所有表" clearable style="flex: 1;">
                                <el-option v-for="t in tables" :key="t" :value="t" :label="t" />
                            </el-select>
                        </div>
                    </div>
                </div>

                <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" style="margin: 12px 0;" />

                <div v-if="resultCount > 0" class="search-info">
                    找到 {{ resultCount }} 个结果
                    <span v-if="searchedTables">（搜索了 {{ searchedTables }} 个表）</span>
                </div>

                <div v-if="searchResults.length > 0" class="search-results">
                    <div
                        v-for="(result, index) in searchResults"
                        :key="index"
                        class="search-result-item"
                        @click="selectResult(result)"
                    >
                        <div class="result-main">
                            {{ formatResult(result) }}
                        </div>
                        <div v-if="result.data" class="result-preview">
                            {{ JSON.stringify(result.data).substring(0, 150) }}...
                        </div>
                    </div>
                </div>

                <div v-else-if="!loading && searchQuery && !error" class="empty-state">
                    未找到匹配结果
                </div>
            </div>
        </el-drawer>
    `
};
