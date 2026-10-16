export default {
    props: ['currentSource', 'editor'],
    emits: ['refresh', 'save', 'delete-key', 'copy'],
    computed: {
        hasKey() {
            return this.editor && this.editor.mode !== 'empty';
        },
        title() {
            if (!this.currentSource) return 'Redis';
            if (!this.hasKey) return `${this.currentSource.name} / DB${this.currentSource.database || '0'}`;
            return this.editor.originalKey || this.editor.key || 'New key';
        },
        isString() {
            return (this.editor?.type || 'string') === 'string';
        },
        isEditableType() {
            return ['string', 'hash', 'list', 'set', 'zset', 'stream'].includes(this.editor?.type || 'string');
        },
        valuePlaceholder() {
            const type = this.editor?.type || 'string';
            if (type === 'hash') return '{\n  "field": "value"\n}';
            if (type === 'list') return '[\n  "item-1",\n  "item-2"\n]';
            if (type === 'set') return '[\n  "member-1",\n  "member-2"\n]';
            if (type === 'zset') return '[\n  { "member": "alice", "score": 1 },\n  { "member": "bob", "score": 2 }\n]';
            if (type === 'stream') return '[\n  { "id": "*", "fields": { "event": "created" } }\n]';
            return 'value';
        },
        valueSize() {
            const value = this.editor?.value || '';
            const bytes = new Blob([value]).size;
            if (bytes < 1024) return `${bytes} B`;
            if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
            return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
        },
    },
    template: `
        <div class="redis-key-panel">
            <div class="redis-key-tabs">
                <div class="redis-key-tab active">
                    <span class="tab-dot"></span>
                    <span>{{ title }}</span>
                    <small v-if="hasKey">{{ editor.type }}</small>
                </div>
            </div>

            <div v-if="!hasKey" class="redis-key-empty">
                <div class="empty-title">选择左侧 Redis key 查看内容</div>
                <div class="empty-subtitle">也可以点击左侧 + Key 新建 String key。</div>
            </div>

            <div v-else class="redis-key-editor">
                <div class="redis-key-header">
                    <div class="redis-field-group redis-type-field">
                        <label>Type</label>
                        <el-select no-data-text="无数据" no-match-text="无匹配数据" v-model="editor.type" :disabled="editor.mode !== 'new'" size="small" style="width: 100%;">
                            <el-option value="string" label="String" />
                            <el-option value="hash" label="Hash" />
                            <el-option value="list" label="List" />
                            <el-option value="set" label="Set" />
                            <el-option value="zset" label="ZSet" />
                            <el-option value="stream" label="Stream" />
                        </el-select>
                    </div>
                    <div class="redis-field-group redis-name-field">
                        <label>Key</label>
                        <el-input v-model="editor.key" :disabled="editor.mode !== 'new'" placeholder="key:name" size="small" />
                    </div>
                    <div class="redis-field-group redis-ttl-field">
                        <label>TTL</label>
                        <el-input-number v-model="editor.ttl" :min="-1" :step="1" placeholder="-1" size="small" controls-position="right" style="width: 100%;" />
                    </div>
                    <el-button size="small" type="danger" plain @click="$emit('delete-key')" :disabled="editor.mode === 'new' || editor.loading || editor.saving" title="删除 Key">⌫</el-button>
                    <el-button size="small" @click="$emit('refresh')" :disabled="editor.loading || editor.saving || editor.mode === 'new'" title="刷新">↻</el-button>
                    <el-button size="small" title="以文本编辑">‹/›</el-button>
                </div>

                <div v-if="editor.error" class="redis-editor-error">{{ editor.error }}</div>

                <div class="redis-value-toolbar">
                    <el-select no-data-text="无数据" no-match-text="无匹配数据" v-model="editor.format" size="small" style="width: 110px;">
                        <el-option value="text" label="Text" />
                        <el-option value="json" label="JSON" />
                    </el-select>
                    <span>Size: {{ valueSize }}</span>
                    <el-button text size="small" @click="$emit('copy', editor.value)">复制</el-button>
                </div>

                <el-input
                    type="textarea"
                    v-model="editor.value"
                    :disabled="!isEditableType || editor.loading"
                    spellcheck="false"
                    :placeholder="valuePlaceholder"
                    :rows="14"
                    class="redis-value-editor"
                />

                <div class="redis-key-footer">
                    <span v-if="editor.loading">加载中...</span>
                    <span v-else-if="editor.saving">保存中...</span>
                    <span v-else-if="editor.mode === 'new'">新建 String key</span>
                    <span v-else>DB{{ currentSource?.database || '0' }}</span>
                    <el-button type="primary" size="small" @click="$emit('save')" :disabled="!isEditableType || editor.loading || editor.saving">保存</el-button>
                </div>
            </div>
        </div>
    `,
};
