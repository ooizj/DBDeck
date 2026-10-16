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

const GROUP_STATE_KEY = 'dbdeck.navigator.collapsedGroups';

const DB_TYPE_META = {
    mysql: { short: 'My', label: 'MySQL' },
    postgresql: { short: 'Pg', label: 'PostgreSQL' },
    sqlite: { short: 'SL', label: 'SQLite' },
    mongodb: { short: 'Mg', label: 'MongoDB' },
    redis: { short: 'Rd', label: 'Redis' },
};

const loadCollapsedGroups = () => {
    try {
        return JSON.parse(localStorage.getItem(GROUP_STATE_KEY) || '{}') || {};
    } catch (e) {
        return {};
    }
};

export default {
    components: { RedisKeyNode },
    props: [
        'tree', 'currentSource', 'expandedIds',
        'redisKeyPattern', 'redisToolbarLoading', 'selectedRedisKeyName'
    ],
    emits: [
        'activate-source', 'toggle-expand', 'collapse-all', 'open-add', 'context-menu', 'open-table',
        'update:redis-key-pattern', 'search-redis-keys', 'reset-redis-key-search', 'select-redis-key'
    ],
    data() {
        return {
            expandedRedisFolders: {},
            collapsedObjectGroups: {},
            collapsedNavGroups: loadCollapsedGroups(), // 连接分组折叠状态，按分组 key 存，持久化到 localStorage
            connectionFilter: '',
            filterText: {}, // 各 SQL/Mongo 数据源的客户端过滤词，按 source.id 存
        };
    },
    methods: {
        // ===== 连接列表：收藏 / 分组 / 未分组 =====
        sourceMatches(source, q) {
            return [source.name, source.host, source.database, source.group_name, source.db_type]
                .some(value => String(value || '').toLowerCase().includes(q));
        },
        isSectionOpen(section) {
            if (!section.title || this.connectionFilter.trim()) return true;
            return this.collapsedNavGroups[section.key] !== true;
        },
        toggleSection(section) {
            if (!section.title) return;
            this.collapsedNavGroups = { ...this.collapsedNavGroups, [section.key]: this.isSectionOpen(section) };
            try {
                localStorage.setItem(GROUP_STATE_KEY, JSON.stringify(this.collapsedNavGroups));
            } catch (e) {
                console.debug('Unable to persist navigator state', e);
            }
        },
        onSectionContextMenu(event, section) {
            if (!section.groupId) return;
            this.$emit('context-menu', event, 'group', { id: section.groupId, name: section.title });
        },
        isExpanded(source) {
            return this.expandedIds.includes(source.id);
        },
        typeMeta(source) {
            return DB_TYPE_META[source.db_type] || { short: (source.db_type || '?').slice(0, 2), label: source.db_type || '' };
        },
        sourceTooltip(source) {
            const lines = [source.name, `${this.typeMeta(source).label} · ${this.sourceMeta(source)}`];
            if (source.use_ssh_tunnel) lines.push(`SSH: ${source.ssh_host || ''}`);
            if (source.group_name) lines.push(`分组: ${source.group_name}`);
            return lines.join('\n');
        },

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
            if (table.comment) return table.comment;
            const type = this.normalizeObjectType(table);
            if (type === 'procedure' || type === 'function') return '';
            const n = table.columns?.length || 0;
            return type === 'collection' ? `${n} 个字段` : `${n} 列`;
        },
        objectTooltip(table) {
            const meta = this.objectMeta(table);
            return meta ? `${table.name}\n${meta}` : table.name;
        },
        canOpenObject(table) {
            return ['table', 'view', 'collection', 'key'].includes(this.normalizeObjectType(table));
        },
        sourceMeta(source) {
            if (source.db_type === 'sqlite') return source.database || 'SQLite 文件';
            if (source.db_type === 'redis') return `${source.host || 'localhost'}/db${source.database || '0'}`;
            const host = source.host || 'localhost';
            const database = source.database || '未选择数据库';
            return `${host}/${database}`;
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
        dbSources() { return this.tree || []; },
        filteredSources() {
            const q = this.connectionFilter.trim().toLowerCase();
            if (!q) return this.dbSources;
            return this.dbSources.filter(source => this.sourceMatches(source, q));
        },
        // 收藏置顶；其余按分组名归类（分组按名称排序），未分组的放最后
        sections() {
            const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true, sensitivity: 'base' });
            const favorites = [];
            const groups = new Map();
            const ungrouped = [];
            this.filteredSources.forEach((source) => {
                if (source.is_favorite) {
                    favorites.push(source);
                } else if (source.group_name) {
                    if (!groups.has(source.group_name)) {
                        groups.set(source.group_name, { groupId: source.group_id, sources: [] });
                    }
                    groups.get(source.group_name).sources.push(source);
                } else {
                    ungrouped.push(source);
                }
            });
            const sections = [];
            if (favorites.length) {
                sections.push({ key: 'favorites', title: '收藏', icon: '★', sources: favorites.sort(byName) });
            }
            [...groups.entries()]
                .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
                .forEach(([name, group]) => {
                    sections.push({ key: `group:${name}`, title: name, icon: '▤', groupId: group.groupId, sources: group.sources.sort(byName) });
                });
            if (ungrouped.length) {
                sections.push({
                    key: 'ungrouped',
                    title: sections.length ? '未分组' : '',
                    icon: '▤',
                    sources: ungrouped.sort(byName),
                });
            }
            return sections;
        },
        redisPatternModel: {
            get() { return this.redisKeyPattern; },
            set(value) { this.$emit('update:redis-key-pattern', value); },
        },
    },
    template: `
        <div class="sidebar-content" style="display: flex; flex-direction: column; flex: 1; overflow: hidden;">
            <div class="sidebar-header">
                <div>
                    <div class="sidebar-title">数据库导航</div>
                    <div class="sidebar-subtitle">{{ dbSources.length }} 个连接</div>
                </div>
                <div class="sidebar-actions">
                    <button class="nav-icon-btn" title="折叠当前连接" :disabled="!expandedIds.length" @click="$emit('collapse-all')">⊟</button>
                    <button class="nav-icon-btn" title="新建连接" @click="$emit('open-add')">＋</button>
                </div>
            </div>
            <div v-if="dbSources.length" class="nav-connection-search">
                <el-input v-model="connectionFilter" size="small" clearable placeholder="搜索连接（名称 / 主机 / 库 / 分组）">
                    <template #prefix><span class="tree-search-icon">⌕</span></template>
                </el-input>
            </div>
            <div class="tree-container" style="flex: 1; overflow-y: auto;">
                <div v-if="!dbSources.length" class="empty-navigator">
                    <div class="empty-title">暂无连接</div>
                    <button class="toolbar-btn" @click="$emit('open-add')">新建连接</button>
                </div>
                <div v-else-if="!filteredSources.length" class="tree-empty-hint">没有匹配的连接</div>
                <template v-for="section in sections" :key="section.key">
                    <div v-if="section.title"
                         :class="['nav-group-header', { favorites: section.key === 'favorites' }]"
                         @click="toggleSection(section)"
                         @contextmenu.prevent.stop="onSectionContextMenu($event, section)">
                        <span :class="['chevron', { expanded: isSectionOpen(section) }]">▶</span>
                        <span class="nav-group-icon">{{ section.icon }}</span>
                        <span class="nav-group-title">{{ section.title }}</span>
                        <span class="nav-group-count">{{ section.sources.length }}</span>
                    </div>
                    <template v-if="isSectionOpen(section)">
                        <div v-for="source in section.sources" :key="'src-' + source.id"
                             :class="['nav-source', { grouped: section.title, expanded: isExpanded(source) }]"
                             @contextmenu.prevent="$emit('context-menu', $event, 'source', source)">
                            <div :class="['tree-item', 'tree-source', { active: currentSource?.id === source.id }]"
                                 :title="sourceTooltip(source)"
                                 @click="$emit('activate-source', source)">
                                <button class="chevron-button" @click.stop="$emit('toggle-expand', source)" :title="isExpanded(source) ? '折叠' : '展开'">
                                    <span v-if="source.loading" class="spinner-small"></span>
                                    <span v-else :class="['chevron', { expanded: isExpanded(source) }]">▶</span>
                                </button>
                                <span :class="['source-badge', 'db-' + source.db_type]">{{ typeMeta(source).short }}</span>
                                <span class="source-label">
                                    <strong>{{ source.name }}</strong>
                                    <small>{{ sourceMeta(source) }}</small>
                                </span>
                                <span v-if="source.error" class="source-state error" title="连接出错"></span>
                                <span v-else-if="currentSource?.id === source.id" class="source-state online" title="已连接"></span>
                            </div>
                            <div v-if="isExpanded(source)" class="tree-children">
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
                                                 :title="objectTooltip(table)"
                                                 @dblclick.prevent.stop="canOpenObject(table) && $emit('open-table', { ...table, source_id: source.id }, 'data')"
                                                 @contextmenu.prevent.stop="canOpenObject(table) && $emit('context-menu', $event, 'table', { ...table, source_id: source.id })">
                                                <span class="object-group-icon object-leaf-icon">{{ objectIcon(table, group) }}</span>
                                                <span class="node-label object">
                                                    <strong>{{ table.name }}</strong>
                                                    <small v-if="objectMeta(table)">{{ objectMeta(table) }}</small>
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
                    </template>
                </template>
            </div>
        </div>
    `
};
