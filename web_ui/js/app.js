import { dbService } from './api.js';
import SourceTree from './components/SourceTree.js?v=nav-groups-20261016';
import SqlEditor from './components/SqlEditor.js?v=sql-editor-20261016';
import ResultArea from './components/ResultArea.js?v=result-20261016c';
import TableObjectView from './components/TableObjectView.js?v=object-20261016';
import AiPanel from './components/AiPanel.js';
import Modals from './components/Modals.js';
import HistoryPanel from './components/HistoryPanel.js';
import ImportPanel from './components/ImportPanel.js';
import { getProvider, listProviders } from './sources/registry.js?v=7features-20260610';
import { useAiChat } from './state/useAiChat.js';
import { useNotifications } from './state/useNotifications.js';
import { useRedis } from './state/useRedis.js';
import { useQueryHistory } from './state/useQueryHistory.js';
import { useSettings } from './state/useSettings.js';
import { useMigration } from './state/useMigration.js';
import { useSqlEditor } from './state/useSqlEditor.js';
import { defaultSourceConfig, sourcePayload } from './utils/sourceHelpers.js';
import { shouldLockSqlEditor } from './utils/editorState.js';

const { createApp, ref, reactive, onMounted, onBeforeUnmount, nextTick, watch, computed, provide } = Vue;

const app = createApp({
    components: { SourceTree, SqlEditor, ResultArea, TableObjectView, AiPanel, Modals, HistoryPanel, ImportPanel },
    setup() {
        const preventNativeContextMenu = event => event.preventDefault();
        // 弹框内的表格单元格：双击/三击只选中该单元格的内容。
        // WebKit 中双击单元格末尾时，原生选区会一直延伸到弹框底部甚至遮罩层。
        const DIALOG_CELL_SELECTOR = '.el-overlay td, .el-overlay th, .el-overlay dd, .el-overlay dt, .el-overlay .plan-node-label, .el-overlay .plan-node-detail';
        const selectDialogCell = (event) => {
            if (event.detail < 2) return;
            const cell = event.target?.closest?.(DIALOG_CELL_SELECTOR);
            if (!cell) return;
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(cell);
            selection.removeAllRanges();
            selection.addRange(range);
        };
        const tree = ref([]);
        const sources = ref([]);
        const currentSource = ref(null);
        const isSourceSwitching = ref(false);
        const isSqlEditorReadOnly = computed(() =>
            shouldLockSqlEditor(isSourceSwitching.value, currentSource.value)
        );
        const currentTables = ref([]);
        const expandedIds = ref([]);
        const workspaceTabs = ref([{ id: 'sql-console', type: 'sql', title: 'SQL 控制台' }]);
        const activeWorkspaceTabId = ref('sql-console');
        const activeWorkspaceTab = computed(() => workspaceTabs.value.find(tab => tab.id === activeWorkspaceTabId.value) || workspaceTabs.value[0]);

        // 左侧栏 tab 状态（database / history）
        const activeTab = ref('database');

        // ========== 会话管理功能 ==========
        const showSessionModal = ref(false);
        const sessionSourceId = ref(null);
        const sessionSourceName = ref('');

        const openSessionManager = (sourceId, sourceName) => {
            contextMenu.show = false;
            sessionSourceId.value = sourceId;
            sessionSourceName.value = sourceName;
            showSessionModal.value = true;
        };

        // ========== 备份功能 ==========
        const showBackupModal = ref(false);
        const backupSourceId = ref(null);
        const backupSourceName = ref('');
        const backupTables = ref([]);

        const supportsBackup = source => {
            if (!source?.db_type) return false;
            const provider = getProvider(source.db_type);
            return provider.id === source.db_type && Boolean(provider.capabilities?.backup);
        };

        const openBackup = async (sourceId, sourceName) => {
            contextMenu.show = false;
            const source = sources.value.find(item => item.id === sourceId);
            if (!supportsBackup(source)) return;
            backupSourceId.value = sourceId;
            backupSourceName.value = sourceName;
            backupTables.value = [];
            
            // 获取表列表
            try {
                const res = await dbService.getMetadata(sourceId);
                if (res.success) {
                    const objectTypes = res.object_types || {};
                    backupTables.value = Object.keys(res.tables || {})
                        .filter(name => (objectTypes[name] || 'table') === 'table');
                }
            } catch (e) {
                console.error('Failed to get tables', e);
            }
            
            showBackupModal.value = true;
        };

        // ========== 执行计划功能 ==========
        const showExplainModal = ref(false);
        const explainSourceId = ref(null);
        const explainQuery = ref('');

        const openExplainPlan = () => {
            if (!currentSource.value || !getEditor()) {
                notify('请先选择数据源并输入SQL', 'warning');
                return;
            }
            
            const query = sqlEditor.getSelectedOrCurrentSql().trim();
            if (!query) {
                notify('请输入要分析的SQL', 'warning');
                return;
            }
            
            explainSourceId.value = currentSource.value.id;
            explainQuery.value = query;
            showExplainModal.value = true;
        };

        // ========== 结构比较功能 ==========
        const showCompareModal = ref(false);
        const compareSourceId = ref(null);
        const compareSourceType = ref('');
        const compareTables = ref([]);

        const openCompareTool = () => {
            const source = currentSource.value;
            if (!source) {
                notify('请先在左侧选择一个连接，再比较其中两张表的结构', 'warning');
                return;
            }
            if (!['mysql', 'postgresql', 'sqlite'].includes(source.db_type)) {
                notify(`${getProvider(source.db_type).displayName} 不支持结构比较`, 'warning');
                return;
            }
            compareSourceId.value = source.id;
            compareSourceType.value = source.db_type;
            compareTables.value = currentTables.value
                .filter(t => (t.object_type || 'table') === 'table' || t.object_type === 'view')
                .map(t => t.name);
            showCompareModal.value = true;
        };

        // File Import
        const showImportModal = ref(false);
        const importSourceId = ref(null);
        const openImport = (sourceId) => {
            contextMenu.show = false;
            importSourceId.value = sourceId;
            showImportModal.value = true;
        };

        const providers = listProviders();
        const currentProvider = computed(() =>
            currentSource.value ? getProvider(currentSource.value.db_type) : null
        );
        const isRedisSource = computed(() => currentSource.value?.db_type === 'redis');

        const queryResult = reactive({
            providerId: '',
            columns: [],
            column_metadata: {},
            rows: [],
            rowCount: 0,
            time: 0,
            durationMs: null,
            error: '',
            errorMsg: '',
            errorCode: null,
            executedSql: '',
            operationKind: '',
            statements: [],
            activeStatementIndex: 0,
            requestedSql: '',
            pagination: null,
            editable: {
                enabled: false,
                sourceId: null,
                table: '',
                primaryKey: null,
                columns: [],
                reason: ''
            },
            isRunning: false
        });
        const resetQueryResult = () => {
            Object.assign(queryResult, {
                providerId: '',
                columns: [],
                column_metadata: {},
                rows: [],
                rowCount: 0,
                time: 0,
                durationMs: null,
                error: '',
                errorMsg: '',
                errorCode: null,
                executedSql: '',
                operationKind: '',
                statements: [],
                activeStatementIndex: 0,
                requestedSql: '',
                pagination: null,
                editable: {
                    enabled: false,
                    sourceId: null,
                    table: '',
                    primaryKey: null,
                    columns: [],
                    reason: ''
                },
                isRunning: false
            });
        };
        const isLoading = ref(false);
        const isTesting = ref(false);
        const isDiscovering = ref(false);
        const availableDatabases = ref([]);

        const { notify, showMessage, showConfirm, showPrompt } = useNotifications();
        // 通过 provide/inject 向所有子组件（含 el-dialog append-to-body 弹窗）提供 dbService，
        // 替代原先的 window.dbService 全局挂载。
        provide('dbService', dbService);

        // --- Composables ---

        const sqlEditor = useSqlEditor({
            dbService,
            getCurrentSource: () => currentSource.value,
            getCurrentProvider: () => currentProvider.value,
            getCurrentTables: () => currentTables.value,
            getProvider,
            isReadOnly: isSqlEditorReadOnly,
            notify,
        });
        const getEditor = sqlEditor.getEditor;

        const aiChat = useAiChat({
            dbService,
            getCurrentSource: () => currentSource.value,
            queryResult,
            notify, showMessage, showConfirm,
        });
        const { chatHistory, aiInput, isGenerating, showConfirmModal, confirmPayload } = aiChat;

        const redis = useRedis({
            dbService,
            getCurrentSource: () => currentSource.value,
            getTree: () => tree.value,
            notify, showMessage, showConfirm,
            loadMetadata: (...args) => loadMetadata(...args),
            getProvider,
        });

        const queryHistory = useQueryHistory({
            dbService,
            getEditor,
            getActiveTab: () => activeTab,
            showMessage, showConfirm, notify,
        });

        const settings = useSettings({
            dbService,
            notify, showMessage,
            isLoading,
            refreshTree: () => refreshTree(),
        });

        const migration = useMigration({
            dbService,
            getTree: () => tree.value,
            getProvider,
            showMessage, showConfirm,
            isLoading,
        });

        // Setup composable watchers
        queryHistory.setupWatchers(activeTab);
        migration.setupWatchers();

        const sidebarWidth = ref(250);
        const aiWidth = ref(300);
        const editorHeight = ref(250);

        const showAddModal = ref(false);
        const isEditing = ref(false);
        const editId = ref(null);
        // defaultSourceConfig 已抽到 ./utils/sourceHelpers.js
        const newSource = reactive(defaultSourceConfig());

        const showDDLModal = ref(false);
        const ddlTable = ref('');
        const ddlContent = ref('');

        const contextMenu = reactive({ show: false, x: 0, y: 0, type: '', data: null, provider: null });
        const contextMenuViewportMargin = 8;
        const clampContextMenuToViewport = async (originX, originY) => {
            await nextTick();
            const menuEl = document.querySelector('.context-menu');
            if (!menuEl || !contextMenu.show) return;

            const rect = menuEl.getBoundingClientRect();
            const maxX = window.innerWidth - rect.width - contextMenuViewportMargin;
            const maxY = window.innerHeight - rect.height - contextMenuViewportMargin;
            const preferredX = originX + rect.width > window.innerWidth - contextMenuViewportMargin
                ? originX - rect.width
                : originX;
            const preferredY = originY + rect.height > window.innerHeight - contextMenuViewportMargin
                ? originY - rect.height
                : originY;

            contextMenu.x = Math.max(contextMenuViewportMargin, Math.min(preferredX, maxX));
            contextMenu.y = Math.max(contextMenuViewportMargin, Math.min(preferredY, maxY));
        };

        // reloadMetadata=false 用于收藏、分组等只影响导航展示的操作，避免重新拉取已展开连接的表结构
        const refreshTree = async ({ reloadMetadata = true } = {}) => {
            contextMenu.show = false;
            isLoading.value = true;
            try {
                const data = await dbService.getTree();

                // 保持原先已加载的 children (表结构元数据) 和错误状态，防止重新加载后树全部收起
                const oldMap = {};
                tree.value.forEach(s => {
                    if ((s.children && s.children.length > 0) || s.error || s.redisKeyPattern) {
                        oldMap[s.id] = {
                            children: s.children || [],
                            error: s.error,
                            redisKeyPattern: s.redisKeyPattern,
                        };
                    }
                });

                data.forEach(s => {
                    if (oldMap[s.id]) {
                        s.children = oldMap[s.id].children;
                        s.error = oldMap[s.id].error;
                        s.redisKeyPattern = oldMap[s.id].redisKeyPattern;
                    }
                });

                tree.value = data;
                sources.value = data.map(s => ({ id: s.id, name: s.name, database: s.database, host: s.host, port: s.port, user: s.user, db_type: s.db_type }));
                if (currentSource.value) {
                    const updatedSource = tree.value.find(s => s.type === 'source' && s.id === currentSource.value.id);
                    if (updatedSource) {
                        currentSource.value = updatedSource;
                        currentTables.value = updatedSource.children || [];
                    }
                }

                // 重新加载当前已展开的数据源的元数据，以刷新表结构
                const refreshPromises = [];
                if (!reloadMetadata) return;
                for (const s of tree.value) {
                    if (s.type === 'source' && expandedIds.value.includes(s.id)) {
                        refreshPromises.push(loadMetadata(s));
                    }
                }
                if (refreshPromises.length > 0) {
                    await Promise.all(refreshPromises);
                }
            } catch (e) {
                notify('刷新连接树失败: ' + e.message, 'error');
            } finally { isLoading.value = false; }
        };

        const loadMetadata = async (source, options = {}) => {
            source.loading = true;
            source.error = null;
            const metadataOptions = {};
            if (source.db_type === 'redis') {
                const pattern = options.keyPattern ?? source.redisKeyPattern ?? '*';
                source.redisKeyPattern = pattern;
                metadataOptions.keyPattern = pattern;
            }
            try {
                const res = await dbService.getMetadata(source.id, metadataOptions);
                if (currentSource.value?.id !== source.id && !expandedIds.value.includes(source.id)) {
                    return;
                }
                if (res.success) {
                    const provider = getProvider(source.db_type);
                    const tableComments = res.table_comments || {};
                    const objectTypes = res.object_types || {};
                    const tableEntries = Object.entries(res.tables || {});
                    const knownNames = new Set(tableEntries.map(([name]) => name));
                    const routineEntries = Object.keys(objectTypes)
                        .filter(name => !knownNames.has(name))
                        .map(name => [name, []]);
                    const tables = [...tableEntries, ...routineEntries].map(([name, columns]) => {
                        const objectType = objectTypes[name] || provider.childLabel;
                        return {
                            name,
                            type: objectType,
                            object_type: objectType,
                            comment: tableComments[name] || '',
                            columns,
                            source_id: source.id,
                        };
                    });
                    tables.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
                    source.children = tables;
                    if (currentSource.value?.id === source.id) currentTables.value = tables;
                } else {
                    source.error = res.error;
                }
            } catch (e) {
                source.error = e.message;
            } finally {
                source.loading = false;
            }
        };

        const disconnectSourceRuntime = async (source, { clearScript = false } = {}) => {
            if (!source) return;
            closeObjectTabs(source.id);
            source.children = [];
            source.error = null;
            source.loading = false;
            if (source.db_type === 'redis') {
                source.redisKeyPattern = undefined;
                redis.resetRedisNavigator(source);
            }
            try {
                await dbService.disconnectSource(source.id);
            } catch (e) {
                console.error('Failed to disconnect source', e);
            }
            if (clearScript) sqlEditor.setValue('');
        };

        const selectSource = async (source) => {
            if (isSourceSwitching.value) return;
            isSourceSwitching.value = true;
            try {
                activeWorkspaceTabId.value = 'sql-console';
                if (currentSource.value?.id === source.id) {
                    expandedIds.value = [source.id];
                    if (!source.children || source.children.length === 0) {
                        await loadMetadata(source);
                    }
                    if (getEditor() && !sqlEditor.getValue()) await sqlEditor.loadSourceScript(source);
                    return;
                }

                await sqlEditor.saveCurrentSourceScript();
                if (currentSource.value) {
                    await disconnectSourceRuntime(currentSource.value);
                }

                expandedIds.value = [source.id];
                currentSource.value = source;
                currentTables.value = source.children || [];
                resetQueryResult();

                if (!source.children || source.children.length === 0) {
                    await loadMetadata(source);
                }
                await sqlEditor.loadSourceScript(source);
            } finally {
                isSourceSwitching.value = false;
            }
        };

        // 展开箭头：非当前连接 → 切换过去并展开；当前连接 → 展开/折叠
        const toggleExpand = async (source) => {
            if (currentSource.value?.id !== source.id) {
                await selectSource(source);
                return;
            }
            const index = expandedIds.value.indexOf(source.id);
            if (index > -1) {
                expandedIds.value = [];
            } else {
                expandedIds.value = [source.id];
                if (!source.children || source.children.length === 0) {
                    await loadMetadata(source);
                }
            }
        };

        // 单击连接行：非当前连接 → 切换过去并展开；当前连接 → 若已折叠则展开（不会因双击而反复折叠）
        const activateSource = async (source) => {
            if (currentSource.value?.id !== source.id) {
                await selectSource(source);
                return;
            }
            if (!expandedIds.value.includes(source.id)) await toggleExpand(source);
        };

        const collapseAll = () => {
            expandedIds.value = [];
        };

        const refreshSource = async (source) => {
            contextMenu.show = false;
            await loadMetadata(source);
        };

        const supportsSessions = source => ['mysql', 'postgresql'].includes(source?.db_type);
        const supportsImport = source => ['mysql', 'postgresql', 'sqlite'].includes(source?.db_type);

        const groupNames = computed(() => [...new Set(
            tree.value.map(source => source.group_name).filter(Boolean)
        )].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })));

        const toggleFavorite = async (source) => {
            contextMenu.show = false;
            try {
                const res = await dbService.toggleFavorite(source.id);
                if (!res.success) throw new Error(res.error || '未知错误');
                source.is_favorite = res.is_favorite;
            } catch (e) {
                showMessage('操作失败: ' + e.message, '错误', 'error');
            }
        };

        const moveSourceToGroup = async (source) => {
            contextMenu.show = false;
            const hint = groupNames.value.length ? `已有分组：${groupNames.value.join('、')}` : '输入新分组名称';
            const name = await showPrompt(`${hint}。留空则移出分组。`, `移动「${source.name}」到分组`, {
                inputValue: source.group_name || '',
                placeholder: '例如：生产 / 测试 / 项目名',
            });
            if (name === null) return;
            try {
                const res = await dbService.setSourceGroup(source.id, name.trim());
                if (!res.success) throw new Error(res.error || '未知错误');
                await refreshTree({ reloadMetadata: false });
            } catch (e) {
                showMessage('移动分组失败: ' + e.message, '错误', 'error');
            }
        };

        const renameGroup = async (group) => {
            contextMenu.show = false;
            const name = await showPrompt('新的分组名称（与已有分组同名时会合并）', '重命名分组', { inputValue: group.name });
            if (name === null || !name.trim() || name.trim() === group.name) return;
            try {
                const res = await dbService.renameGroup(group.id, name.trim());
                if (!res.success) throw new Error(res.error || '未知错误');
                await refreshTree({ reloadMetadata: false });
            } catch (e) {
                showMessage('重命名分组失败: ' + e.message, '错误', 'error');
            }
        };

        const ungroupGroup = async (group) => {
            contextMenu.show = false;
            if (!await showConfirm(`解散分组「${group.name}」？其中的连接会移到未分组，不会删除连接。`)) return;
            try {
                const res = await dbService.ungroup(group.id);
                if (!res.success) throw new Error(res.error || '未知错误');
                await refreshTree({ reloadMetadata: false });
            } catch (e) {
                showMessage('解散分组失败: ' + e.message, '错误', 'error');
            }
        };

        const closeSource = async (source) => {
            const index = expandedIds.value.indexOf(source.id);
            if (index > -1) expandedIds.value.splice(index, 1);
            const wasCurrentSource = currentSource.value?.id === source.id;
            if (wasCurrentSource) {
                aiChat.cancelGeneration();
                await sqlEditor.saveCurrentSourceScript();
                currentSource.value = null;
                currentTables.value = [];
                resetQueryResult();
            }
            await disconnectSourceRuntime(source, { clearScript: wasCurrentSource });
            contextMenu.show = false;
        };

        const testConnection = async () => {
            isTesting.value = true;
            try {
                const res = await dbService.testConnection(newSource);
                if (res.success) notify('连接成功！', 'success');
                else showMessage('连接失败: ' + res.error, '错误', 'error');
            } catch (e) { showMessage('测试请求异常: ' + e.message, '错误', 'error'); }
            finally { isTesting.value = false; }
        };

        const discoverDatabases = async () => {
            isDiscovering.value = true;
            try {
                const res = await dbService.listDatabases(newSource);
                if (res.success) {
                    availableDatabases.value = res.databases;
                    notify(`成功获取到 ${res.databases.length} 个数据库`, 'success');
                } else {
                    showMessage('获取数据库列表失败: ' + res.error, '错误', 'error');
                }
            } catch (e) {
                showMessage('请求异常: ' + e.message, '错误', 'error');
            } finally {
                isDiscovering.value = false;
            }
        };

        const saveSource = async () => {
            if (!newSource.name || !newSource.name.trim()) {
                notify('请输入连接名称', 'error');
                return;
            }
            if (newSource.type === 'mysql' && (!newSource.database || !newSource.database.trim())) {
                notify('请选择或填写 MySQL 数据库名称', 'error');
                return;
            }
            isLoading.value = true;
            try {
                const res = await dbService.saveSource(newSource, isEditing.value ? editId.value : null);
                if (res.success) {
                    showAddModal.value = false;
                    notify('保存成功', 'success');
                    await refreshTree();
                } else {
                    showMessage('保存失败: ' + res.error, '错误', 'error');
                }
            } catch (e) {
                showMessage('保存请求异常: ' + e.message, '错误', 'error');
            } finally {
                isLoading.value = false;
            }
        };

        // sourcePayload 已抽到 ./utils/sourceHelpers.js

        const duplicateSource = async (source) => {
            contextMenu.show = false;
            isLoading.value = true;
            try {
                const payload = sourcePayload(source, {
                    name: `${source.name || '连接'} 副本`,
                });
                const res = await dbService.saveSource(payload);
                if (res.success) {
                    notify('连接已复制', 'success');
                    await refreshTree();
                } else {
                    showMessage('复制连接失败: ' + (res.error || '未知错误'), '错误', 'error');
                }
            } catch (e) {
                showMessage('复制连接请求异常: ' + e.message, '错误', 'error');
            } finally {
                isLoading.value = false;
            }
        };

        const deleteSource = async (source) => {
            if (await showConfirm(`确定要删除数据源 "${source.name}" 吗？`)) {
                try {
                    if (currentSource.value?.id === source.id) {
                        aiChat.cancelGeneration();
                        closeObjectTabs(source.id);
                        currentSource.value = null;
                        currentTables.value = [];
                        expandedIds.value = expandedIds.value.filter(id => id !== source.id);
                        sqlEditor.setValue('');
                        resetQueryResult();
                        if (source.db_type === 'redis') redis.resetRedisNavigator(source);
                    }
                    await dbService.deleteSource(source.id);
                    contextMenu.show = false;
                    notify('删除成功', 'success');
                    await refreshTree();
                } catch (e) {
                    showMessage('删除失败: ' + e.message, '错误', 'error');
                }
            }
        };

        const openAddSource = () => {
            isEditing.value = false;
            editId.value = null;
            availableDatabases.value = [];
            Object.assign(newSource, defaultSourceConfig());
            showAddModal.value = true;
        };

        // 切换数据源时同步 Monaco 语言 + 注册补全
        watch(currentSource, (source) => {
            sqlEditor.applyEditorLanguage();
            sqlEditor.ensureCompletionRegistered();
            if (source?.db_type === 'redis') {
                redis.redisKeyPattern.value = source.redisKeyPattern || '*';
            } else {
                redis.resetRedisKeyEditor();
                nextTick(() => sqlEditor.layout());
            }
        });

        // 切换 newSource.type 时，重置一些字段默认值
        watch(() => newSource.type, (type) => {
            const provider = getProvider(type);
            if (provider.defaultPort) newSource.port = provider.defaultPort;
            if (!newSource.ssh_port) newSource.ssh_port = 22;
            if (type === 'mongodb') {
                if (newSource.direct_connection === undefined) newSource.direct_connection = true;
            } else if (type === 'redis') {
                if (!newSource.database) newSource.database = '0';
                if (!isEditing.value && newSource.user === 'root') newSource.user = '';
            } else if (type === 'mysql') {
                if (!newSource.user) newSource.user = 'root';
            }
        });

        const editSource = (source) => {
            isEditing.value = true;
            editId.value = source.id;
            Object.assign(newSource, sourcePayload(source));
            showAddModal.value = true;
            contextMenu.show = false;
        };

        const copyToClipboard = async (text) => {
            const value = String(text ?? '');
            try {
                if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(value);
                } else {
                    const textarea = document.createElement('textarea');
                    textarea.value = value;
                    textarea.style.position = 'fixed';
                    textarea.style.left = '-9999px';
                    document.body.appendChild(textarea);
                    textarea.focus();
                    textarea.select();
                    document.execCommand('copy');
                    document.body.removeChild(textarea);
                }
                contextMenu.show = false;
                notify('已拷贝到剪贴板', 'success');
            } catch (e) {
                showMessage('拷贝失败: ' + (e.message || e), '错误', 'error');
            }
        };

        const supportsResultEditing = (source) => ['mysql', 'postgresql', 'sqlite', 'mongodb'].includes(source?.db_type);

        const normalizePrimaryKey = (primaryKey) => {
            if (Array.isArray(primaryKey)) return primaryKey.filter(Boolean);
            return primaryKey ? [primaryKey] : [];
        };

        const getMongoEditableTable = (query) => {
            const text = String(query || '');
            const getCollectionMatch = text.match(/db\.getCollection\(\s*['"]([^'"]+)['"]\s*\)\s*\.\s*(find|findOne)\s*\(/);
            if (getCollectionMatch) return getCollectionMatch[1];
            const dotMatch = text.match(/db\.([A-Za-z_$][\w$]*)\s*\.\s*(find|findOne)\s*\(/);
            return dotMatch ? dotMatch[1] : '';
        };

        const markPrimaryKeyColumns = (columns = [], primaryKey = null) => {
            const pkSet = new Set(normalizePrimaryKey(primaryKey).map(String));
            return columns.map(col => ({
                ...col,
                primary_key: Boolean(col.primary_key) || pkSet.has(String(col.name)),
                key: pkSet.has(String(col.name)) ? 'PRI' : (col.key || col.Key || col.COLUMN_KEY || ''),
            }));
        };

        const closeObjectTabs = (sourceId = null) => {
            workspaceTabs.value = workspaceTabs.value.filter(tab =>
                tab.id === 'sql-console' || (sourceId !== null && tab.source?.id !== sourceId)
            );
            if (!workspaceTabs.value.some(tab => tab.id === activeWorkspaceTabId.value)) {
                activeWorkspaceTabId.value = 'sql-console';
            }
        };

        const ensureActiveWorkspaceTab = (fallbackId = 'sql-console') => {
            if (workspaceTabs.value.some(tab => tab.id === activeWorkspaceTabId.value)) return;
            const fallback = workspaceTabs.value.find(tab => tab.id === fallbackId) || workspaceTabs.value[0];
            activeWorkspaceTabId.value = fallback?.id || 'sql-console';
        };

        const buildEditableContext = async (source, table) => {
            const context = {
                enabled: false,
                sourceId: source.id,
                table: table.name,
                primaryKey: null,
                columns: [],
                reason: ''
            };
            if (!supportsResultEditing(source)) {
                context.reason = '当前数据源暂不支持结果集编辑';
                return context;
            }
            if (source?.db_type === 'mongodb') {
                context.primaryKey = '_id';
                context.columns = [{ name: '_id', key: 'PRI', type: 'ObjectId', nullable: false }];
                context.enabled = true;
                return context;
            }
            try {
                const [colResult, pkResult] = await Promise.all([
                    dbService.getTableColumns(source.id, table.name),
                    dbService.getPrimaryKey(source.id, table.name)
                ]);
                context.columns = colResult.success ? (colResult.columns || []) : [];
                context.primaryKey = pkResult.success ? pkResult.primary_key : null;
                const pkColumns = normalizePrimaryKey(context.primaryKey);
                if (!pkColumns.length) {
                    context.reason = '表没有主键，结果集只读';
                    return context;
                }
                context.enabled = true;
                return context;
            } catch (e) {
                context.reason = '获取主键/列信息失败，结果集只读';
                return context;
            }
        };

        const buildEditableContextFromMetadata = (source, columns, columnMetadata, query = '') => {
            const context = {
                enabled: false,
                sourceId: source?.id ?? null,
                table: '',
                primaryKey: null,
                columns: [],
                reason: '结果无法定位到单个带主键的源表'
            };
            if (!supportsResultEditing(source)) {
                context.reason = '当前数据源暂不支持结果集编辑';
                return context;
            }
            if (source?.db_type === 'mongodb') {
                if (!columns.includes('_id')) {
                    context.reason = '结果中缺少 _id，无法安全编辑';
                    return context;
                }
                const table = getMongoEditableTable(query);
                context.table = table;
                context.primaryKey = '_id';
                context.columns = columns.map(name => ({
                    name,
                    source_column: name,
                    table,
                    key: name === '_id' ? 'PRI' : '',
                    type: name === '_id' ? 'ObjectId' : '',
                    nullable: true
                }));
                context.enabled = Boolean(table);
                context.reason = table ? '' : '无法识别 Mongo collection，无法安全编辑';
                return context;
            }
            const metas = columns
                .map(displayColumn => ({ displayColumn, meta: columnMetadata?.[displayColumn] }))
                .filter(item => item.meta?.table && item.meta?.source_column);
            const tables = [...new Set(metas.map(item => item.meta.table))];
            if (tables.length !== 1) return context;
            const pkDisplayColumns = metas
                .filter(item => item.meta.primary_key)
                .map(item => item.displayColumn);
            if (!pkDisplayColumns.length) {
                context.reason = '结果中缺少主键列，无法安全编辑';
                return context;
            }
            context.table = tables[0];
            context.primaryKey = pkDisplayColumns;
            context.columns = metas.map(item => ({
                name: item.displayColumn,
                source_column: item.meta.source_column,
                table: item.meta.table,
                key: item.meta.primary_key ? 'PRI' : '',
                type: item.meta.type || '',
                nullable: true
            }));
            context.enabled = true;
            context.reason = '';
            return context;
        };

        const viewData = async (table) => {
            contextMenu.show = false;
            openTableTab(table, 'data');
        };

        const previewTableData = async (table) => {
            const source = tree.value.find(s => s.id === table.source_id);
            if (!source) return;
            if (currentSource.value?.id !== source.id) return;
            await nextTick();
            const provider = getProvider(source.db_type);
            const query = provider.buildPreviewQuery(table);
            const editableContext = await buildEditableContext(source, table);
            executeQuery(query, { editableContext });
        };

        const openTableTab = async (table, pane = 'info') => {
            contextMenu.show = false;
            const source = tree.value.find(s => s.id === table.source_id);
            if (!source) return;
            if (currentSource.value?.id !== source.id) {
                closeObjectTabs();
                currentSource.value = source;
                currentTables.value = source.children || [];
            }
            const tableFromTree = (source.children || []).find(item => item.name === table.name);
            const tablePayload = { ...(tableFromTree || table), source_id: source.id };
            if (!['mysql', 'postgresql', 'sqlite'].includes(source.db_type)) {
                previewTableData(tablePayload);
                return;
            }
            const id = `table:${source.id}:${tablePayload.name}`;
            const existing = workspaceTabs.value.find(tab => tab.id === id);
            if (existing) {
                // 已打开的表只切换面板；不替换 table 对象、不再查询，避免视图重新加载
                existing.pane = pane;
                activeWorkspaceTabId.value = id;
                return;
            }
            try {
                const pkResult = await dbService.getPrimaryKey(source.id, tablePayload.name);
                if (pkResult?.success) {
                    tablePayload.columns = markPrimaryKeyColumns(tablePayload.columns || [], pkResult.primary_key);
                }
            } catch (e) {
                console.debug('Failed to enrich primary key metadata', e);
            }
            if (!workspaceTabs.value.some(tab => tab.id === id)) {
                workspaceTabs.value.push({
                    id,
                    type: 'table',
                    title: tablePayload.name,
                    subtitle: source.database || source.name,
                    source,
                    table: tablePayload,
                    pane,
                });
            }
            activeWorkspaceTabId.value = id;
        };

        const closeWorkspaceTab = (tab) => {
            contextMenu.show = false;
            if (tab.id === 'sql-console') return;
            const idx = workspaceTabs.value.findIndex(item => item.id === tab.id);
            if (idx < 0) return;
            workspaceTabs.value.splice(idx, 1);
            if (activeWorkspaceTabId.value === tab.id) {
                const next = workspaceTabs.value[Math.max(0, idx - 1)] || workspaceTabs.value[0];
                activeWorkspaceTabId.value = next.id;
            }
        };

        const closeOtherWorkspaceTabs = (tab) => {
            contextMenu.show = false;
            workspaceTabs.value = workspaceTabs.value.filter(item =>
                item.id === 'sql-console' || item.id === tab.id
            );
            activeWorkspaceTabId.value = workspaceTabs.value.some(item => item.id === tab.id)
                ? tab.id
                : 'sql-console';
        };

        const closeWorkspaceTabsToRight = (tab) => {
            contextMenu.show = false;
            const idx = workspaceTabs.value.findIndex(item => item.id === tab.id);
            if (idx < 0) return;
            workspaceTabs.value = workspaceTabs.value.filter((item, itemIdx) =>
                item.id === 'sql-console' || itemIdx <= idx
            );
            ensureActiveWorkspaceTab(tab.id);
        };

        const closeAllWorkspaceTabs = () => {
            contextMenu.show = false;
            workspaceTabs.value = workspaceTabs.value.filter(tab => tab.id === 'sql-console');
            activeWorkspaceTabId.value = 'sql-console';
        };

        const hasWorkspaceTabsToRight = (tab) => {
            const idx = workspaceTabs.value.findIndex(item => item.id === tab.id);
            return idx > -1 && workspaceTabs.value.slice(idx + 1).some(item => item.id !== 'sql-console');
        };

        const handleWorkspaceTabContextMenu = (e, tab) => {
            e.preventDefault();
            activeWorkspaceTabId.value = tab.id;
            contextMenu.show = true;
            contextMenu.x = e.clientX;
            contextMenu.y = e.clientY;
            contextMenu.type = 'workspace-tab';
            contextMenu.data = tab;
            contextMenu.provider = null;
            clampContextMenuToViewport(e.clientX, e.clientY);
        };

        const selectRedisKey = async (table) => {
            if (table?.name) redis.selectedRedisKeyName.value = table.name;
            await previewTableData(table);
        };

        const copyInsertLabel = (table) => (
            contextMenu.provider?.copyInsertLabel?.(table) || '复制 INSERT'
        );

        const copyInsert = async (table) => {
            contextMenu.show = false;
            const source = tree.value.find(s => s.id === table.source_id);
            if (!source) return;
            const provider = getProvider(source.db_type);
            const redisType = table.columns?.find(col => col.name === 'type')?.type;
            if (source.db_type === 'redis' && redisType === 'string') {
                try {
                    const data = await dbService.executeSql(provider.buildSelectQuery(table), source.id);
                    const active = data?.statements?.[data.active_statement_index || 0] || data;
                    const columns = active?.columns || [];
                    const row = active?.data?.[0];
                    const valueIndex = columns.indexOf('value');
                    if (data?.success !== false && row && valueIndex >= 0) {
                        const value = Array.isArray(row) ? row[valueIndex] : row.value;
                        copyToClipboard(provider.buildInsertQuery(table, value));
                        return;
                    }
                } catch (error) {
                    console.debug('Unable to build Redis SET command', error);
                }
                notify('无法读取 Redis 当前值', 'warning');
                return;
            }
            copyToClipboard(provider.buildInsertQuery(table));
        };

        const copySelect = (table) => {
            contextMenu.show = false;
            const source = tree.value.find(s => s.id === table.source_id);
            if (!source) return;
            copyToClipboard(getProvider(source.db_type).buildSelectQuery(table));
        };

        const applyQueryResult = (data, fallbackSql, elapsedSeconds, editableContext = null) => {
            const statements = Array.isArray(data.statements) ? data.statements : [];
            const activeIndex = Number.isInteger(data.active_statement_index)
                ? data.active_statement_index
                : Math.max(statements.length - 1, 0);
            const active = statements[activeIndex] || null;
            const columns = (active?.columns || data.columns || []);
            const columnMetadata = (active?.column_metadata || data.column_metadata || {});
            const executedQuery = data.executed_query || data.executed_sql || active?.executed_query || fallbackSql;
            const inferredEditableContext = editableContext
                || buildEditableContextFromMetadata(currentSource.value, columns, columnMetadata, executedQuery);
            const inferredPkColumns = normalizePrimaryKey(inferredEditableContext?.primaryKey);
            const editable = inferredEditableContext
                ? {
                    ...inferredEditableContext,
                    enabled: Boolean(
                        inferredEditableContext.enabled
                        && inferredPkColumns.length
                        && inferredPkColumns.every(col => columns.includes(col))
                    ),
                    reason: inferredEditableContext.enabled && inferredPkColumns.some(col => !columns.includes(col))
                        ? '结果中缺少主键列，无法安全编辑'
                        : inferredEditableContext.reason
                }
                : {
                    enabled: false,
                    sourceId: null,
                    table: '',
                    primaryKey: null,
                    columns: [],
                    reason: '手写 SQL 结果默认只读'
                };
            Object.assign(queryResult, {
                providerId: data.provider_id || currentSource.value?.db_type || '',
                error: '',
                errorMsg: '',
                errorCode: null,
                columns,
                column_metadata: columnMetadata,
                rows: (active?.data || data.data || []),
                rowCount: active?.row_count ?? data.row_count ?? data.data?.length ?? 0,
                time: elapsedSeconds,
                durationMs: data.duration_ms ?? null,
                executedSql: executedQuery,
                requestedSql: data.query || fallbackSql,
                operationKind: data.operation_kind || active?.operation_kind || '',
                statements,
                activeStatementIndex: activeIndex,
                pagination: data.pagination ? {
                    loading: false,
                    start: data.pagination.start,
                    end: data.pagination.end,
                    total: data.pagination.total,
                    page: data.pagination.page,
                    pageSize: data.pagination.page_size,
                    totalPages: data.pagination.total_pages,
                    disabled: false,
                } : null,
                editable
            });
        };

        const executeQuery = async (queryOverride, options = {}) => {
            if (isSqlEditorReadOnly.value) return;
            let query = queryOverride;
            if (!query) query = sqlEditor.getSelectedOrCurrentSql();
            if (!query || !query.trim() || !currentSource.value) {
                if (!currentSource.value) notify('请先选择一个数据源', 'warning');
                return;
            }

            const sourceId = currentSource.value.id;
            queryResult.isRunning = true;
            if (queryResult.pagination) queryResult.pagination.disabled = true;
            try {
                const start = Date.now();
                const supportsPagination = ['mysql', 'postgresql', 'sqlite'].includes(currentSource.value.db_type)
                    && options.paginate !== false;
                const data = await dbService.executeSql(query, sourceId, {
                    page: supportsPagination ? (options.page || 1) : null,
                    pageSize: options.pageSize || 100,
                });
                if (currentSource.value?.id !== sourceId) return;
                queryResult.time = ((Date.now() - start) / 1000).toFixed(3);
                if (data.success === false) {
                    queryResult.error = data.error;
                    queryResult.errorMsg = data.error_msg;
                    queryResult.errorCode = data.error_code;
                    queryResult.statements = data.statements || [];
                    queryResult.operationKind = data.operation_kind || '';
                    queryResult.durationMs = data.duration_ms ?? null;
                    queryResult.executedSql = data.executed_query || data.executed_sql || query;
                    queryResult.requestedSql = query;
                    queryResult.pagination = null;
                    queryResult.editable = {
                        enabled: false,
                        sourceId: null,
                        table: '',
                        primaryKey: null,
                        columns: [],
                        reason: ''
                    };
                } else {
                    applyQueryResult(data, query, queryResult.time, options.editableContext || null);
                }
            } catch (e) {
                Object.assign(queryResult, {
                    error: e.detail || e.message || String(e),
                    errorMsg: e.detail || e.message || String(e),
                    errorCode: e.status || 500,
                    columns: [],
                    rows: [],
                    rowCount: 0,
                    durationMs: null,
                    executedSql: query,
                    requestedSql: query,
                    operationKind: '',
                    statements: [],
                    pagination: null,
                    editable: {
                        enabled: false,
                        sourceId: null,
                        table: '',
                        primaryKey: null,
                        columns: [],
                        reason: ''
                    }
                });
            } finally {
                if (currentSource.value?.id === sourceId) {
                    queryResult.isRunning = false;
                }
            }
        };

        // 分页结果（单条只读 SELECT）才允许"导出全部"：后端会不分页重新执行 requestedSql
        const exportAllSpec = computed(() => {
            if (!queryResult.pagination || !currentSource.value || !queryResult.requestedSql) return null;
            return { sourceId: currentSource.value.id, query: queryResult.requestedSql };
        });

        const changeQueryPage = (delta) => {
            const pagination = queryResult.pagination;
            if (!pagination || queryResult.isRunning) return;
            const nextPage = Math.min(Math.max(pagination.page + delta, 1), pagination.totalPages);
            if (nextPage === pagination.page) return;
            executeQuery(queryResult.requestedSql || queryResult.executedSql, {
                page: nextPage,
                pageSize: pagination.pageSize,
                editableContext: queryResult.editable,
            });
        };

        const refreshQuery = () => {
            executeQuery(queryResult.requestedSql || queryResult.executedSql, {
                page: queryResult.pagination?.page || 1,
                pageSize: queryResult.pagination?.pageSize || 100,
                editableContext: queryResult.editable,
            });
        };

        const startResize = (type) => {
            document.body.style.userSelect = 'none';
            document.body.style.webkitUserSelect = 'none';
            const onMove = (e) => {
                if (type === 'sidebar') sidebarWidth.value = Math.min(Math.max(e.clientX, 220), 420);
                else if (type === 'ai') aiWidth.value = Math.min(Math.max(window.innerWidth - e.clientX, 280), 520);
                else if (type === 'editor') {
                    const rect = document.querySelector('.editor-container')?.getBoundingClientRect();
                    if (rect) editorHeight.value = Math.min(Math.max(e.clientY - rect.top, 180), window.innerHeight - 260);
                }
            };
            const onUp = () => {
                document.body.style.userSelect = '';
                document.body.style.webkitUserSelect = '';
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        };

        onMounted(() => {
            document.addEventListener('contextmenu', preventNativeContextMenu);
            document.addEventListener('click', selectDialogCell);
            document.addEventListener('dblclick', selectDialogCell);
            sqlEditor.mountEditor({
                onExecute: () => executeQuery(),
                onReady: () => {
                    if (currentSource.value) sqlEditor.loadSourceScript(currentSource.value);
                },
            });
            refreshTree();
            window.addEventListener('click', () => { contextMenu.show = false; });
        });

        onBeforeUnmount(() => {
            document.removeEventListener('contextmenu', preventNativeContextMenu);
            document.removeEventListener('click', selectDialogCell);
            document.removeEventListener('dblclick', selectDialogCell);
        });

        return {
            providers, currentProvider,
            tree, currentSource, currentTables, expandedIds, queryResult, chatHistory, aiInput, isLoading, isTesting, isGenerating,
            isSqlEditorReadOnly,
            isRedisSource, sidebarWidth, aiWidth, editorHeight, showAddModal, isEditing, newSource,
            showDDLModal, ddlTable, ddlContent, contextMenu,
            sources,
            notify, showMessage, showConfirm,
            availableDatabases, isDiscovering,
            refreshTree, selectSource, toggleExpand, activateSource, collapseAll, refreshSource, closeSource,
            supportsSessions, supportsImport, groupNames, toggleFavorite, moveSourceToGroup, renameGroup, ungroupGroup, saveSource, duplicateSource, deleteSource, editSource, openAddSource, testConnection, discoverDatabases, copyToClipboard,
            viewData, copyInsert, copyInsertLabel, copySelect, executeQuery, exportAllSpec, changeQueryPage, refreshQuery, startResize,
            askAI: aiChat.askAI, exportChat: aiChat.exportChat, stopGeneration: aiChat.stopGeneration, clearChat: aiChat.clearChat,
            setEditorSql: sqlEditor.setValue, formatSql: sqlEditor.formatSql,
            selectRedisKey, loadMetadata,
            workspaceTabs, activeWorkspaceTabId, activeWorkspaceTab, openTableTab, closeWorkspaceTab, closeOtherWorkspaceTabs,
            closeWorkspaceTabsToRight, closeAllWorkspaceTabs, hasWorkspaceTabsToRight, handleWorkspaceTabContextMenu, previewTableData,
            showConfirmModal, confirmPayload, confirmApprove: aiChat.confirmApprove, confirmReject: aiChat.confirmReject,
            activeTab,
            showImportModal, importSourceId, openImport,

            // 会话管理功能
            showSessionModal, sessionSourceId, sessionSourceName,
            openSessionManager,

            // 备份功能
            showBackupModal, backupSourceId, backupSourceName, backupTables,
            openBackup, supportsBackup,

            // 执行计划功能
            showExplainModal, explainSourceId, explainQuery,
            openExplainPlan,

            // 结构比较功能
            showCompareModal, compareSourceId, compareSourceType, compareTables,
            openCompareTool,

            // From redis composable (spread flat for template compatibility)
            redisKeyPattern: redis.redisKeyPattern,
            redisToolbarLoading: redis.redisToolbarLoading,
            selectedRedisKeyName: redis.selectedRedisKeyName,
            redisKeyEditor: redis.redisKeyEditor,
            searchRedisKeys: () => redis.searchRedisKeys(expandedIds),
            resetRedisKeySearch: () => redis.resetRedisKeySearch(expandedIds),
            addRedisKey: () => redis.addRedisKey(isRedisSource.value),
            loadRedisKey: redis.loadRedisKey,
            saveRedisKey: redis.saveRedisKey,
            refreshRedisKey: redis.refreshRedisKey,
            deleteRedisKey: redis.deleteRedisKey,

            // From query history composable
            historyItems: queryHistory.historyItems,
            historySearch: queryHistory.historySearch,
            loadHistory: queryHistory.loadHistory,
            selectHistoryItem: queryHistory.selectHistoryItem,
            clearAllHistory: queryHistory.clearAllHistory,

            // From settings composable
            showConfigModal: settings.showConfigModal,
            systemConfig: settings.systemConfig,
            openSettings: settings.openSettings,
            saveSettings: settings.saveSettings,
            exportConfig: settings.exportConfig,
            importConfig: settings.importConfig,
            importDbeaverConfig: settings.importDbeaverConfig,
            importDbeaverFile: settings.importDbeaverFile,

            // From migration composable
            showMigrateModal: migration.showMigrateModal,
            migrateSourceId: migration.migrateSourceId,
            migrateDestId: migration.migrateDestId,
            migrateTables: migration.migrateTables,
            selectedMigrateTables: migration.selectedMigrateTables,
            migrateSources: migration.migrateSources,
            migrateTablesLoading: migration.migrateTablesLoading,
            migrateTablesError: migration.migrateTablesError,
            handleMigrateSourceChange: migration.handleMigrateSourceChange,
            doMigrate: migration.doMigrate,

            handleContextMenu: (e, type, data) => {
                e.preventDefault();
                contextMenu.show = true;
                contextMenu.x = e.clientX;
                contextMenu.y = e.clientY;
                contextMenu.type = type;
                contextMenu.data = data;
                if (type === 'table') {
                    const source = tree.value.find(s => s.id === data.source_id);
                    contextMenu.provider = source ? getProvider(source.db_type) : null;
                } else if (type === 'source') {
                    contextMenu.provider = getProvider(data.db_type);
                } else {
                    contextMenu.provider = null;
                }
                clampContextMenuToViewport(e.clientX, e.clientY);
            }
        };
    }
});
if (typeof ElementPlus !== 'undefined') {
    app.use(ElementPlus);
}
app.mount('#app');
