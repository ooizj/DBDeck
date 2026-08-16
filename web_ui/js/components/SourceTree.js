const RedisKeyNode = {
    name: 'RedisKeyNode',
    props: ['node', 'source', 'expandedFolders', 'selectedKeyName'],
    emits: ['toggle-folder', 'select-key', 'context-menu'],
    methods: {
        isExpanded(path) {
            return !!this.expandedFolders[path];
        },
        keyType(table) {
            return table.columns?.find(c => c.name === 'type')?.type || 'key';
        },
    },
    template: `
        <div class="redis-key-node">
            <div v-if="node.kind === 'folder'">
                <div class="tree-item redis-folder" @click="$emit('toggle-folder', node.path)">
                    <span :class="['chevron', { expanded: isExpanded(node.path) }]">▶</span>
                    <span class="redis-folder-icon" aria-hidden="true"></span>
                    <span class="node-label object">
                        <strong>{{ node.label }}</strong>
                        <small>{{ node.count }}</small>
                    </span>
                </div>
                <div v-if="isExpanded(node.path)" class="redis-folder-children">
                    <redis-key-node
                        v-for="child in node.children"
                        :key="child.id"
                        :node="child"
                        :source="source"
                        :expanded-folders="expandedFolders"
                        :selected-key-name="selectedKeyName"
                        @toggle-folder="$emit('toggle-folder', $event)"
                        @select-key="$emit('select-key', $event)"
                        @context-menu="$emit('context-menu', $event)"
                    ></redis-key-node>
                </div>
            </div>
            <div v-else
                 :class="['tree-item', 'redis-key-leaf', { active: selectedKeyName === node.table.name }]"
                 @click="$emit('select-key', { ...node.table, source_id: source.id })"
                 @contextmenu.prevent.stop="$emit('context-menu', { event: $event, type: 'table', data: { ...node.table, source_id: source.id } })">
                <span class="redis-key-icon" aria-hidden="true"></span>
                <span class="node-label object">
                    <strong>{{ node.label }}</strong>
                    <small>{{ keyType(node.table) }}</small>
                </span>
            </div>
        </div>
    `,
};

export default {
    components: { RedisKeyNode },
    props: [
        'tree', 'currentSource', 'expandedIds',
        'redisKeyPattern', 'redisToolbarLoading', 'selectedRedisKeyName'
    ],
    emits: [
        'select-source', 'refresh', 'open-add', 'open-migrate', 'edit-source', 'delete-source', 'context-menu', 'refresh-node', 'toggle-expand', 'view-data', 'open-table',
        'update:redis-key-pattern', 'search-redis-keys', 'reset-redis-key-search', 'select-redis-key'
    ],
    data() {
        return {
            expandedRedisFolders: {},
            collapsedObjectGroups: {},
            filterText: {}, // 各 SQL/Mongo 数据源的客户端过滤词，按 source.id 存
        };
    },
    methods: {
        // ===== 统一导航树搜索 =====
        searchPlaceholder(source) {
            if (source.db_type === 'redis') return 'Enter 搜索 key';
            if (source.db_type === 'mongodb') return '过滤集合';
            return '过滤对象';
        },
        onFilterInput(source, val) {
            if (source.db_type === 'redis') {
                this.redisPatternModel = val; // 走服务端 key pattern 搜索（回车触发）
            } else {
                this.filterText = { ...this.filterText, [source.id]: val }; // 客户端即时过滤
            }
        },
        onFilterClear(source) {
            if (source.db_type === 'redis') this.$emit('reset-redis-key-search');
        },
        visibleChildren(source) {
            const list = source.children || [];
            const q = (this.filterText[source.id] || '').trim().toLowerCase();
            if (!q) return list;
            return list.filter(t => String(t.name || '').toLowerCase().includes(q));
        },
        normalizeObjectType(table) {
            const type = String(table.object_type || table.type || 'table').toLowerCase();
            if (type === 'collection') return 'collection';
            if (type === 'view') return 'view';
            if (type === 'procedure') return 'procedure';
            if (type === 'function') return 'function';
            if (type === 'key') return 'key';
            return 'table';
        },
        objectGroups(source) {
            const items = this.visibleChildren(source);
            if (source.db_type === 'mongodb') {
                return [{
                    key: 'collections',
                    title: '集合',
                    icon: '▦',
                    items: items.filter(item => this.normalizeObjectType(item) === 'collection'),
                }];
            }
            const definitions = [
                { key: 'tables', title: '表', icon: '▦', types: ['table'] },
                { key: 'views', title: '视图', icon: '◫', types: ['view'] },
                { key: 'procedures', title: '存储过程', icon: 'ƒ', types: ['procedure'] },
                { key: 'functions', title: '函数', icon: 'λ', types: ['function'] },
            ];
            return definitions.map(group => ({
                ...group,
                items: items.filter(item => group.types.includes(this.normalizeObjectType(item))),
            }));
        },
        objectGroupKey(source, group) {
            return `${source.id}:${group.key}`;
        },
        isObjectGroupExpanded(source, group) {
            const key = this.objectGroupKey(source, group);
            if (group.key === 'tables' || group.key === 'collections') {
                return this.collapsedObjectGroups[key] !== true;
            }
            return this.collapsedObjectGroups[key] === false;
        },
        toggleObjectGroup(source, group) {
            const key = this.objectGroupKey(source, group);
            this.collapsedObjectGroups = {
                ...this.collapsedObjectGroups,
                [key]: this.isObjectGroupExpanded(source, group),
            };
        },
        objectIcon(table, group = null) {
            if (group?.icon) return group.icon;
            const type = this.normalizeObjectType(table);
            if (type === 'collection') return '▦';
            if (type === 'view') return '◫';
            if (type === 'procedure') return 'ƒ';
            if (type === 'function') return 'λ';
            return '▦';
        },
        objectMeta(table) {
            const n = table.columns?.length || 0;
            if (table.comment) return table.comment;
            const type = this.normalizeObjectType(table);
            if (type === 'collection') return n + ' fields';
            if (type === 'procedure') return 'procedure';
            if (type === 'function') return 'function';
            return n + ' columns';
        },
        canOpenObject(table) {
            return ['table', 'view', 'collection', 'key'].includes(this.normalizeObjectType(table));
        },
        sourceMeta(source) {
            if (source.db_type === 'sqlite') return source.database || 'SQLite file';
            if (source.db_type === 'redis') return `${source.host || 'localhost'}/db${source.database || '0'}`;
            const host = source.host || 'localhost';
            const database = source.database || '未选择数据库';
            return `${host}/${database}`;
        },
        sourceBadge(source) {
            const type = source.db_type || 'mysql';
            return type.slice(0, 3).toUpperCase();
        },
        keyType(table) {
            return table.columns?.find(c => c.name === 'type')?.type || 'key';
        },
        toggleRedisFolder(path) {
            this.expandedRedisFolders[path] = !this.expandedRedisFolders[path];
        },
        buildRedisTree(children) {
            const root = [];
            const folderMap = new Map();
            const ensureFolder = (parts, sourcePath) => {
                const id = sourcePath.join(':');
                if (folderMap.has(id)) return folderMap.get(id);
                const node = {
                    id: `folder:${id}`,
                    kind: 'folder',
                    label: parts[parts.length - 1],
                    path: id,
                    count: 0,
                    children: [],
                };
                folderMap.set(id, node);
                if (parts.length === 1) {
                    root.push(node);
                } else {
                    const parent = ensureFolder(parts.slice(0, -1), sourcePath.slice(0, -1));
                    parent.children.push(node);
                }
                return node;
            };

            (children || []).forEach((table) => {
                const segments = String(table.name || '').split(':').filter(Boolean);
                const leaf = {
                    id: `key:${table.name}`,
                    kind: 'key',
                    label: segments.length ? segments[segments.length - 1] : table.name,
                    table,
                };
                if (segments.length > 1) {
                    const folder = ensureFolder(segments.slice(0, -1), segments.slice(0, -1));
                    folder.children.push(leaf);
                } else {
                    root.push(leaf);
                }
            });

            const sortNodes = (nodes) => {
                nodes.forEach((node) => {
                    if (node.kind === 'folder') {
                        sortNodes(node.children);
                        node.count = node.children.reduce((sum, child) => sum + (child.kind === 'folder' ? child.count : 1), 0);
                    }
                });
                nodes.sort((a, b) => {
                    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
                    return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' });
                });
            };
            sortNodes(root);
            return root;
        },
    },
    computed: {
        dbSources() { return (this.tree || []).filter(n => n.type !== 'workspace'); },
        redisPatternModel: {
            get() { return this.redisKeyPattern; },
            set(value) { this.$emit('update:redis-key-pattern', value); },
        },
    },
    template: `
        <div class="sidebar-content" style="display: flex; flex-direction: column; flex: 1; overflow: hidden;">
            <div class="sidebar-header">
                <div>
                    <div class="sidebar-title">Database Navigator</div>
                    <div class="sidebar-subtitle">{{ dbSources.length }} connections</div>
                </div>
            </div>
            <div class="tree-container" style="flex: 1; overflow-y: auto;">
                <div v-if="!dbSources.length" class="empty-navigator">
                    <div class="empty-title">暂无连接</div>
                    <button class="toolbar-btn" @click="$emit('open-add')">新建连接</button>
                </div>
                <div v-for="source in dbSources" :key="'src-' + source.id" class="tree-node" @contextmenu.prevent="$emit('context-menu', $event, 'source', source)">
                    <div :class="['tree-item', 'tree-source', { active: currentSource?.id === source.id }]"
                         @dblclick.prevent.stop="$emit('select-source', source)">
                        <button class="chevron-button" @click.stop="$emit('toggle-expand', source)" :title="expandedIds.includes(source.id) ? '折叠' : '展开'">
                            <span v-if="source.loading" class="spinner-small"></span>
                            <span v-else :class="['chevron', { expanded: expandedIds.includes(source.id) }]">▶</span>
                        </button>
                        <span class="source-badge">{{ sourceBadge(source) }}</span>
                        <span class="node-label">
                            <strong>{{ source.name }}</strong>
                            <small>{{ sourceMeta(source) }}</small>
                        </span>
                    </div>
                    <div v-if="expandedIds.includes(source.id)" class="tree-children">
                        <!-- 统一搜索框：所有数据源结构一致（第一行搜索框 + 下面对象列表） -->
                        <div class="tree-search" @click.stop>
                            <el-input
                                :model-value="source.db_type === 'redis' ? redisPatternModel : (filterText[source.id] || '')"
                                @update:model-value="onFilterInput(source, $event)"
                                @keydown.enter.prevent="source.db_type === 'redis' && $emit('search-redis-keys')"
                                @clear="onFilterClear(source)"
                                :placeholder="searchPlaceholder(source)"
                                size="small"
                                clearable>
                                <template #prefix><span class="tree-search-icon">⌕</span></template>
                            </el-input>
                        </div>

                        <template v-if="source.db_type === 'redis'">
                            <redis-key-node
                                v-for="node in buildRedisTree(source.children)"
                                :key="node.id"
                                :node="node"
                                :source="source"
                                :expanded-folders="expandedRedisFolders"
                                :selected-key-name="selectedRedisKeyName"
                                @toggle-folder="toggleRedisFolder"
                                @select-key="$emit('select-redis-key', $event)"
                                @context-menu="$emit('context-menu', $event.event, $event.type, $event.data)"
                            ></redis-key-node>
                        </template>
                        <template v-else>
                            <div v-for="group in objectGroups(source)" :key="group.key" class="tree-object-group">
                                <div class="tree-item object-group-header" @click="toggleObjectGroup(source, group)">
                                    <span :class="['chevron', { expanded: isObjectGroupExpanded(source, group) }]">▶</span>
                                    <span class="object-group-icon">{{ group.icon }}</span>
                                    <span class="node-label object-group-label">
                                        <strong>{{ group.title }}</strong>
                                        <small>{{ group.items.length }}</small>
                                    </span>
                                </div>
                                <div v-if="isObjectGroupExpanded(source, group)" class="object-group-children">
                                    <div v-for="table in group.items" :key="table.name"
                                         :class="['tree-item', 'object-leaf', { muted: !canOpenObject(table) }]"
                                         @dblclick.prevent.stop="canOpenObject(table) && $emit('open-table', { ...table, source_id: source.id }, 'data')"
                                         @contextmenu.prevent.stop="canOpenObject(table) && $emit('context-menu', $event, 'table', { ...table, source_id: source.id })">
                                        <span class="object-group-icon object-leaf-icon">{{ objectIcon(table, group) }}</span>
                                        <span class="node-label object">
                                            <strong>{{ table.name }}</strong>
                                            <small>{{ objectMeta(table) }}</small>
                                        </span>
                                    </div>
                                    <div v-if="!source.loading && !source.error && group.items.length === 0" class="tree-empty-hint object-group-empty">
                                        暂无{{ group.title }}
                                    </div>
                                </div>
                            </div>
                            <div v-if="!source.loading && !source.error && (source.children && source.children.length) && visibleChildren(source).length === 0" class="tree-empty-hint">
                                无匹配对象
                            </div>
                        </template>

                        <div v-if="source.db_type === 'redis' && !source.loading && !source.error && (!source.children || source.children.length === 0)" class="redis-empty-keys">
                            <span>没有匹配的 key</span>
                            <button class="toolbar-btn" @click="$emit('reset-redis-key-search')">显示全部</button>
                        </div>
                        <div v-if="source.loading" class="redis-empty-keys">
                            <span class="spinner-small"></span>
                            <span>{{ source.db_type === 'redis' ? '加载 key...' : '加载中...' }}</span>
                        </div>
                        <div v-if="source.error" class="tree-error-hint">
                            ⚠️ {{ source.error }}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `
};
