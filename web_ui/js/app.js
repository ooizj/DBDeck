import { dbService } from './api.js';
import SourceTree from './components/SourceTree.js?v=nav-20260702a';
import SqlEditor from './components/SqlEditor.js?v=sql-editor-20260729a';
import ResultArea from './components/ResultArea.js?v=result-20260702f';
import TableObjectView from './components/TableObjectView.js?v=object-20260701b';
import AiPanel from './components/AiPanel.js';
import Modals from './components/Modals.js';
import HistoryPanel from './components/HistoryPanel.js';
import ImportPanel from './components/ImportPanel.js';
import { getProvider, listProviders } from './sources/registry.js?v=7features-20260610';
import { useAiSession } from './state/useAiSession.js';
import { useNotifications } from './state/useNotifications.js';
import { useRedis } from './state/useRedis.js';
import { useQueryHistory } from './state/useQueryHistory.js';
import { useSettings } from './state/useSettings.js';
import { useMigration } from './state/useMigration.js';
import { splitSqlStatementsWithOffsets } from './utils/sqlHelpers.js';
import { defaultSourceConfig, sourcePayload } from './utils/sourceHelpers.js';
import { shouldLockSqlEditor, updateEditorReadOnly } from './utils/editorState.js';

const { createApp, ref, reactive, onMounted, onBeforeUnmount, nextTick, watch, computed, provide } = Vue;

const app = createApp({
    components: { SourceTree, SqlEditor, ResultArea, TableObjectView, AiPanel, Modals, HistoryPanel, ImportPanel },
    setup() {
        const preventNativeContextMenu = event => event.preventDefault();
        const tree = ref([]);
        const sources = ref([]);
        const currentSource = ref(null);
        const isSourceSwitching = ref(false);
        const isSqlEditorReadOnly = computed(() =>
            shouldLockSqlEditor(isSourceSwitching.value, currentSource.value)
        );
        const currentTables = ref([]);
        const expandedIds = ref([]);
        const workspaceTabs = ref([{ id: 'sql-console', type: 'sql', title: 'SQL Console' }]);
        const activeWorkspaceTabId = ref('sql-console');
        const activeWorkspaceTab = computed(() => workspaceTabs.value.find(tab => tab.id === activeWorkspaceTabId.value) || workspaceTabs.value[0]);

        const showConfirmModal = ref(false);
        const confirmPayload = ref(null);

        // 左侧栏 tab 状态（database / history）
        const activeTab = ref('database');
        const editorMode = ref('sql'); // 仅 SQL 控制台（文件编辑器已移除）

        // ========== 数据编辑功能 ==========
        const showDataEditModal = ref(false);
        const dataEditSourceId = ref(null);
        const dataEditTable = ref('');
        const dataEditMode = ref('insert');
        const dataEditData = ref(null);
        const dataEditColumns = ref([]);
        const dataEditPrimaryKey = ref(null);

        const openDataEdit = async (sourceId, table, mode = 'insert', editData = null) => {
            contextMenu.show = false;
            dataEditSourceId.value = sourceId;
            dataEditTable.value = table;
            dataEditMode.value = mode;
            dataEditData.value = editData;
            
            // 获取列信息
            try {
                const colResult = await dbService.getTableColumns(sourceId, table);
                if (colResult.success) {
                    dataEditColumns.value = colResult.columns || [];
                }
                const pkResult = await dbService.getPrimaryKey(sourceId, table);
                if (pkResult.success) {
                    dataEditPrimaryKey.value = pkResult.primary_key;
                }
            } catch (e) {
                console.error('Failed to get column info', e);
            }
            
            showDataEditModal.value = true;
        };

        const onDataEditSaved = async () => {
            notify('数据已保存', 'success');
            // 刷新当前表数据
            if (currentSource.value && dataEditTable.value) {
                await viewData({ source_id: currentSource.value.id, name: dataEditTable.value });
            }
        };

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
                    backupTables.value = Object.keys(res.tables || {});
                }
            } catch (e) {
                console.error('Failed to get tables', e);
            }
            
            showBackupModal.value = true;
        };

        // ========== 搜索功能 ==========
        const showSearchPanel = ref(false);
        const searchSourceId = ref(null);
        const searchTables = ref([]);

        const openSearchPanel = () => {
            if (currentSource.value) {
                searchSourceId.value = currentSource.value.id;
                searchTables.value = currentTables.value.map(t => t.name);
            }
            showSearchPanel.value = true;
        };

        const onSelectSearchResult = (result) => {
            // 处理搜索结果选择
            if (result.type === 'table') {
                // 如果选择了表，在编辑器中生成查询
                if (editor) {
                    editor.setValue(`SELECT * FROM ${result.name} LIMIT 100;`);
                }
            } else if (result.table) {
                // 如果选择了数据，打开表数据
                viewData({ source_id: searchSourceId.value, name: result.table });
            }
        };

        // ========== 执行计划功能 ==========
        const showExplainModal = ref(false);
        const explainSourceId = ref(null);
        const explainQuery = ref('');

        const openExplainPlan = () => {
            if (!currentSource.value || !editor) {
                notify('请先选择数据源并输入SQL', 'warning');
                return;
            }
            
            const query = editor.getValue().trim();
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
            if (currentSource.value) {
                if (currentSource.value.db_type === 'mongodb') {
                    notify('MongoDB 暂不支持结构比较', 'warning');
                    return;
                }
                compareSourceId.value = currentSource.value.id;
                compareSourceType.value = currentSource.value.db_type;
                compareTables.value = currentTables.value.map(t => t.name);
            }
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
        const chatHistory = ref([{ role: 'ai', content: '欢迎来到 DBDeck。选择左侧连接后，可以让我解释结构、生成查询或分析结果。' }]);
        const aiInput = ref('');
        const isLoading = ref(false);
        const isTesting = ref(false);
        const isDiscovering = ref(false);
        const availableDatabases = ref([]);
        const isGenerating = ref(false);
        const { aiSessionId } = useAiSession();
        let abortController = null;

        const { notify, showMessage, showConfirm } = useNotifications();
        // 通过 provide/inject 向所有子组件（含 el-dialog append-to-body 弹窗）提供 dbService，
        // 替代原先的 window.dbService 全局挂载。
        provide('dbService', dbService);

        // --- Composables ---

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
            getEditor: () => editor,
            getEditorMode: () => editorMode,
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
            showMessage,
            isLoading,
        });

        // Setup composable watchers
        queryHistory.setupWatchers(activeTab);
        migration.setupWatchers();

        const sidebarWidth = ref(250);
        const aiWidth = ref(300);
        const editorHeight = ref(250);

        let editor = null;
        let autoSaveTimer = null;
        let suggestDetailsTimer = null;
        let isApplyingScript = false;
        watch(isSqlEditorReadOnly, readOnly => updateEditorReadOnly(editor, readOnly));
        // 已注册过 completion provider 的 Monaco language id，避免重复注册
        const registeredLanguages = new Set();

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

        const refreshTree = async () => {
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

        const applyEditorLanguage = () => {
            if (!editor || !currentSource.value) return;
            const provider = getProvider(currentSource.value.db_type);
            monaco.editor.setModelLanguage(editor.getModel(), provider.editorLanguage);
        };

        const setEditorScript = (content) => {
            if (!editor) return;
            isApplyingScript = true;
            try {
                editor.setValue(content || '');
                applyEditorLanguage();
            } finally {
                isApplyingScript = false;
            }
        };

        const loadSourceScript = async (source) => {
            if (!source || !editor) return;
            try {
                const res = await dbService.getScript(source.id);
                if (res.success) setEditorScript(res.content || '');
            } catch (e) {
                console.error('Failed to fetch script', e);
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
            if (clearScript && editor) editor.setValue('');
        };

        const saveCurrentSourceScript = async () => {
            if (currentSource.value && editor) {
                if (autoSaveTimer) {
                    clearTimeout(autoSaveTimer);
                    autoSaveTimer = null;
                }
                try {
                    await dbService.saveScript(currentSource.value.id, editor.getValue());
                } catch (e) {
                    console.error('Failed to save script', e);
                }
            }
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
                    editorMode.value = 'sql';
                    if (editor && !editor.getValue()) await loadSourceScript(source);
                    return;
                }

                await saveCurrentSourceScript();
                if (currentSource.value) {
                    await disconnectSourceRuntime(currentSource.value);
                }

                expandedIds.value = [source.id];
                currentSource.value = source;
                currentTables.value = source.children || [];
                editorMode.value = 'sql';
                resetQueryResult();

                if (!source.children || source.children.length === 0) {
                    await loadMetadata(source);
                }
                await loadSourceScript(source);
            } finally {
                isSourceSwitching.value = false;
            }
        };

        const toggleExpand = async (source) => {
            if (currentSource.value?.id !== source.id) {
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

        const closeSource = async (source) => {
            const index = expandedIds.value.indexOf(source.id);
            if (index > -1) expandedIds.value.splice(index, 1);
            const wasCurrentSource = currentSource.value?.id === source.id;
            if (wasCurrentSource) {
                if (abortController) {
                    abortController.abort();
                    abortController = null;
                }
                isGenerating.value = false;
                await saveCurrentSourceScript();
                currentSource.value = null;
                currentTables.value = [];
                editorMode.value = 'sql';
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
                        if (abortController) {
                            abortController.abort();
                            abortController = null;
                        }
                        closeObjectTabs(source.id);
                        isGenerating.value = false;
                        currentSource.value = null;
                        currentTables.value = [];
                        expandedIds.value = expandedIds.value.filter(id => id !== source.id);
                        editorMode.value = 'sql';
                        if (editor) editor.setValue('');
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
            applyEditorLanguage();
            ensureCompletionRegistered();
            if (source?.db_type === 'redis') {
                redis.redisKeyPattern.value = source.redisKeyPattern || '*';
            } else {
                redis.resetRedisKeyEditor();
                nextTick(() => {
                    if (editor) editor.layout();
                });
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
            try {
                const pkResult = await dbService.getPrimaryKey(source.id, tablePayload.name);
                if (pkResult?.success) {
                    tablePayload.columns = markPrimaryKeyColumns(tablePayload.columns || [], pkResult.primary_key);
                }
            } catch (e) {
                console.debug('Failed to enrich primary key metadata', e);
            }
            const id = `table:${source.id}:${tablePayload.name}`;
            const existing = workspaceTabs.value.find(tab => tab.id === id);
            if (!existing) {
                workspaceTabs.value.push({
                    id,
                    type: 'table',
                    title: tablePayload.name,
                    subtitle: source.database || source.name,
                    source,
                    table: tablePayload,
                    pane,
                });
            } else {
                existing.table = tablePayload;
                existing.source = source;
                existing.pane = pane;
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
            contextMenu.provider?.copyInsertLabel?.(table) || 'Copy INSERT'
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

        // splitSqlStatementsWithOffsets 已抽到 ./utils/sqlHelpers.js

        const getCurrentSqlStatement = () => {
            if (!editor) return '';
            const model = editor.getModel();
            const text = model.getValue();
            if (currentSource.value?.db_type === 'redis') {
                const line = model.getLineContent(editor.getPosition().lineNumber).trim();
                if (line && !line.startsWith('#')) return line;
                const commands = text
                    .split(/\r?\n/)
                    .map(item => item.trim())
                    .filter(item => item && !item.startsWith('#'));
                return commands[0] || '';
            }
            const offset = model.getOffsetAt(editor.getPosition());
            const statements = splitSqlStatementsWithOffsets(text);
            const current = statements.find(stmt => offset >= stmt.start && offset <= stmt.end);
            return (current || statements[0])?.text || '';
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
            if (!query && editor) {
                const selection = editor.getSelection();
                if (selection && !selection.isEmpty()) {
                    query = editor.getModel().getValueInRange(selection);
                } else {
                    query = getCurrentSqlStatement();
                }
            }
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

        const executeAllSql = () => {
            if (!editor || !currentSource.value) return;
            executeQuery(editor.getValue());
        };

        const runQuery = async (queryText, { showAsUser = true } = {}) => {
            if (isGenerating.value) return;
            isGenerating.value = true;
            abortController = new AbortController();
            if (showAsUser) chatHistory.value.push({ role: 'user', content: queryText });
            try {
                const response = await fetch('/api/query', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        query: queryText,
                        source_id: currentSource.value?.id,
                        workspace_id: null,
                        session_id: aiSessionId
                    }),
                    signal: abortController.signal
                });
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop();
                    for (const line of lines) { if (line.trim()) handleAIEvent(JSON.parse(line)); }
                }
            } catch (e) {
                if (e.name === 'AbortError') chatHistory.value.push({ role: 'ai', content: '已停止生成。', isFinal: true, collapsed: false });
                else chatHistory.value.push({ role: 'ai', content: '错误: ' + e.message });
            } finally { isGenerating.value = false; abortController = null; }
        };

        const askAI = async () => {
            const input = aiInput.value.trim();
            if (!input || isGenerating.value) return;
            aiInput.value = '';
            await runQuery(input);
        };

        const confirmApprove = async () => {
            if (!confirmPayload.value) return;
            const pid = confirmPayload.value.pending_id;
            const calls = confirmPayload.value.calls;
            showConfirmModal.value = false;
            chatHistory.value.push({
                role: 'ai',
                content: `✓ 用户已确认：${calls.map(c => c.tool).join(', ')}`,
                isFinal: true,
                isSystem: true
            });
            confirmPayload.value = null;
            await runQuery(`__confirm__:${pid}:approve`, { showAsUser: false });
        };

        const confirmReject = async () => {
            if (!confirmPayload.value) return;
            const pid = confirmPayload.value.pending_id;
            showConfirmModal.value = false;
            chatHistory.value.push({
                role: 'ai',
                content: '✗ 用户已拒绝执行该批次操作。',
                isFinal: true,
                isSystem: true
            });
            confirmPayload.value = null;
            await runQuery(`__confirm__:${pid}:reject`, { showAsUser: false });
        };

        const handleAIEvent = (e) => {
            const lastMsg = chatHistory.value[chatHistory.value.length - 1];
            if (e.type === 'delta') {
                if (lastMsg && lastMsg.role === 'ai' && !lastMsg.isFinal) {
                    lastMsg.content += e.content;
                } else {
                    chatHistory.value.push({ role: 'ai', content: e.content, isFinal: false, collapsed: false });
                }
            } else if (e.type === 'tool_start') {
                chatHistory.value.push({ role: 'tool_log', tool: e.tool, args: e.args, done: false });
            } else if (e.type === 'tool_end') {
                const log = [...chatHistory.value].reverse().find(m => m.role === 'tool_log' && m.tool === e.tool && !m.done);
                if (log) {
                    log.done = true;
                    log.result = e.result;
                }
            } else if (e.type === 'confirm_required') {
                confirmPayload.value = { pending_id: e.pending_id, calls: e.calls };
                showConfirmModal.value = true;
            } else if (e.type === 'final') {
                if (lastMsg && lastMsg.role === 'ai' && !lastMsg.isFinal) {
                    lastMsg.isFinal = true;
                    if (e.queries && e.queries.length) lastMsg.queries = e.queries;
                    else delete lastMsg.queries;
                    if (e.sql) lastMsg.sql = e.sql;
                    else delete lastMsg.sql;
                    if (!lastMsg.content || lastMsg.content.trim() === '') lastMsg.content = e.answer;
                } else {
                    const newMsg = { role: 'ai', content: e.answer, isFinal: true, collapsed: false };
                    if (e.queries && e.queries.length) newMsg.queries = e.queries;
                    if (e.sql) newMsg.sql = e.sql;
                    chatHistory.value.push(newMsg);
                }
                if (e.data && (
                    e.data.source_id === undefined
                    || e.data.source_id === null
                    || currentSource.value?.id === e.data.source_id
                )) {
                    Object.assign(queryResult, {
                        columns: e.data.columns || [],
                        column_metadata: e.data.column_metadata || {},
                        rows: e.data.data || [],
                        rowCount: e.data.row_count,
                        time: 'AI',
                        durationMs: e.data.duration_ms ?? null,
                        executedSql: e.data.executed_queries?.length ? e.data.executed_queries.join('\n') : e.data.executed_sql,
                        operationKind: e.data.operation_kind || '',
                        statements: e.data.statements || [],
                        activeStatementIndex: e.data.active_statement_index || 0,
                        editable: {
                            enabled: false,
                            sourceId: null,
                            table: '',
                            primaryKey: null,
                            columns: [],
                            reason: 'AI 查询结果默认只读'
                        }
                    });
                }
            } else if (e.type === 'error') {
                chatHistory.value.push({ role: 'ai', content: '❌ 错误: ' + e.message, isFinal: true, isError: true });
            }
            nextTick(() => { const box = document.querySelector('.ai-chat'); if (box) box.scrollTop = box.scrollHeight; });
        };

        const exportChat = async () => {
            let markdown = '# 数据库客户端 AI 对话记录\n\n';
            markdown += `导出时间: ${new Date().toLocaleString('zh-CN')}\n\n`;
            if (currentSource.value) {
                markdown += `数据源: ${currentSource.value.name} (${currentSource.value.database})\n\n`;
            }
            markdown += '---\n\n';
            let messageIndex = 0;
            chatHistory.value.forEach((msg, idx) => {
                if (msg.role === 'user') {
                    messageIndex++;
                    markdown += `## 用户 (${messageIndex})\n\n${msg.content}\n\n`;
                } else if (msg.role === 'ai') {
                    messageIndex++;
                    markdown += `## AI 助手 (${messageIndex})\n\n${msg.content}\n\n`;
                    if (msg.queries?.length) markdown += `**执行的查询:**\n\`\`\`\n${msg.queries.join('\n')}\n\`\`\`\n\n`;
                    else if (msg.sql) markdown += `**执行的查询:**\n\`\`\`\n${msg.sql}\n\`\`\`\n\n`;

                    const isLastMsg = (idx === chatHistory.value.length - 1);
                    if (!msg.isFinal && isLastMsg) {
                        markdown += `_（此消息可能未完成或被中断）_\n\n`;
                    }
                } else if (msg.role === 'tool_log') {
                    markdown += `> 🛠️ **工具调用**: \`${msg.tool}\` (${msg.done ? '已完成' : '执行中'})\n`;
                    if (msg.args) {
                        markdown += `> * **请求参数**:\n>   \`\`\`json\n>   ${JSON.stringify(msg.args, null, 2).split('\n').join('\n>   ')}\n>   \`\`\`\n`;
                    }
                    if (msg.result) {
                        markdown += `> * **返回结果**:\n>   \`\`\`json\n>   ${JSON.stringify(msg.result, null, 2).split('\n').join('\n>   ')}\n>   \`\`\`\n`;
                    }
                    markdown += `\n`;
                }
            });

            const filename = `chat-export-${Date.now()}.md`;
            if (window.pywebview?.api?.save_markdown) {
                try {
                    const res = await window.pywebview.api.save_markdown(filename, markdown);
                    if (res?.success) {
                        notify('聊天记录已导出', 'success');
                    } else if (!res?.cancelled) {
                        showMessage('导出失败: ' + (res?.error || '未知错误'), '错误', 'error');
                    }
                    return;
                } catch (e) {
                    showMessage('导出失败: ' + e.message, '错误', 'error');
                    return;
                }
            }

            if (window.showSaveFilePicker) {
                try {
                    const handle = await window.showSaveFilePicker({
                        suggestedName: filename,
                        types: [{
                            description: 'Markdown',
                            accept: { 'text/markdown': ['.md'] },
                        }],
                    });
                    const writable = await handle.createWritable();
                    await writable.write(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
                    await writable.close();
                    notify('聊天记录已导出', 'success');
                    return;
                } catch (e) {
                    if (e.name === 'AbortError') return;
                    showMessage('导出失败: ' + e.message, '错误', 'error');
                    return;
                }
            }

            const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            notify('聊天记录已导出', 'success');
        };

        const stopGeneration = () => {
            if (abortController) {
                abortController.abort();
                abortController = null;
            }
        };

        const clearChat = async () => {
            if (await showConfirm('确定要清空对话历史吗？')) {
                try {
                    await dbService.clearChat(aiSessionId);
                    chatHistory.value = [{ role: 'ai', content: '对话已清空，请开始新的对话。' }];
                    notify('对话已清空', 'success');
                } catch (e) {
                    showMessage('清空失败: ' + e.message, '错误', 'error');
                }
            }
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

        const ensureCompletionRegistered = () => {
            if (!editor || !currentProvider.value) return;
            const lang = currentProvider.value.editorLanguage;
            if (registeredLanguages.has(lang)) return;
            const completion = currentProvider.value.registerCompletion(monaco, {
                getCurrentTables: () => currentTables.value,
                getCurrentSource: () => currentSource.value,
                getModelText: () => (editor ? editor.getValue() : ''),
            });
            if (completion && completion.provideCompletionItems) {
                monaco.languages.registerCompletionItemProvider(lang, completion);
                registeredLanguages.add(lang);
            }
        };

        const setEditorSql = (sql) => {
            if (editor) editor.setValue(sql);
        };

        const formatSql = () => {
            if (!editor) return;
            const fmt = window.sqlFormatter;
            if (!fmt) {
                notify('SQL 格式化库未加载', 'warning');
                return;
            }
            if (typeof fmt.format !== 'function') {
                notify('sqlFormatter 对象异常', 'error');
                return;
            }
            const selection = editor.getSelection();
            const hasSelection = selection && !selection.isEmpty();
            const sql = hasSelection
                ? editor.getModel().getValueInRange(selection)
                : editor.getValue();
            if (!sql.trim()) return;
            const language = currentSource.value?.db_type === 'postgresql' ? 'postgresql' : 'mysql';
            try {
                const formatted = fmt.format(sql, { language });
                if (hasSelection) {
                    editor.executeEdits('format', [{ range: selection, text: formatted }]);
                } else {
                    const fullRange = editor.getModel().getFullModelRange();
                    editor.executeEdits('format', [{ range: fullRange, text: formatted }]);
                }
                notify('格式化完成', 'success');
            } catch (e) {
                notify('格式化失败: ' + e.message, 'error');
            }
        };

        const isRelationSuggestContext = () => {
            if (!editor) return false;
            const model = editor.getModel();
            const position = editor.getPosition();
            if (!model || !position) return false;
            const line = model.getLineContent(position.lineNumber);
            const textBeforeCursor = line.substring(0, position.column - 1);
            return /(?:^|\s)(?:FROM|JOIN)\s+[`"]?[\w$]*$/i.test(textBeforeCursor);
        };

        const isSuggestDetailsVisible = () => {
            const details = document.querySelector('.suggest-details:not(.no-docs)');
            if (!details) return false;
            const style = window.getComputedStyle(details);
            return details.offsetParent !== null && style.display !== 'none' && style.visibility !== 'hidden';
        };

        const autoOpenSuggestDetails = () => {
            if (!editor || !isRelationSuggestContext()) return;
            const widget = document.querySelector('.suggest-widget.visible');
            if (!widget || isSuggestDetailsVisible()) return;
            try {
                editor.trigger('auto-open-suggest-details', 'toggleSuggestionDetails', {});
            } catch (e) {
                console.debug('Unable to open suggestion details', e);
            }
        };

        const scheduleSuggestDetails = () => {
            if (suggestDetailsTimer) clearTimeout(suggestDetailsTimer);
            suggestDetailsTimer = setTimeout(() => {
                autoOpenSuggestDetails();
                setTimeout(autoOpenSuggestDetails, 160);
            }, 80);
        };

        onMounted(() => {
            document.addEventListener('contextmenu', preventNativeContextMenu);
            require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' }});
            require(['vs/editor/editor.main'], () => {
                monaco.editor.defineTheme('dbdeck-dark', {
                    base: 'vs-dark',
                    inherit: true,
                    rules: [],
                    colors: {
                        'editor.background': '#101820',
                        'editor.foreground': '#d7dde5',
                        'editorLineNumber.foreground': '#66717f',
                        'editorCursor.foreground': '#5fb3ff',
                        'editor.selectionBackground': '#26465f',
                        'editor.lineHighlightBackground': '#172330',
                    },
                });
                editor = monaco.editor.create(document.getElementById('monaco-editor'), {
                    value: '',
                    language: 'mysql',
                    theme: 'dbdeck-dark',
                    readOnly: isSqlEditorReadOnly.value,
                    domReadOnly: isSqlEditorReadOnly.value,
                    automaticLayout: true,
                    minimap: { enabled: false },
                    fontSize: 13,
                    lineHeight: 20,
                    scrollBeyondLastLine: false,
                    tabSize: 4,
                    renderLineHighlight: 'all',
                    suggest: {
                        showInlineDetails: true,
                        showStatusBar: true,
                        preview: true,
                    },
                });
                editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
                    executeQuery();
                });
                editor.onDidChangeModelContent(() => {
                    if (isApplyingScript) {
                        scheduleSuggestDetails();
                        return;
                    }
                    if (autoSaveTimer) clearTimeout(autoSaveTimer);
                    const sourceId = currentSource.value?.id;
                    const content = editor.getValue();
                    autoSaveTimer = setTimeout(() => {
                        if (sourceId) dbService.saveScript(sourceId, content);
                    }, 2000);
                    scheduleSuggestDetails();
                });
                editor.onDidChangeCursorPosition(scheduleSuggestDetails);
                ensureCompletionRegistered();
                if (currentSource.value) loadSourceScript(currentSource.value);
            });
            refreshTree();
            window.addEventListener('click', () => { contextMenu.show = false; });
        });

        onBeforeUnmount(() => {
            document.removeEventListener('contextmenu', preventNativeContextMenu);
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
            refreshTree, selectSource, toggleExpand, closeSource, saveSource, duplicateSource, deleteSource, editSource, openAddSource, testConnection, discoverDatabases, copyToClipboard,
            viewData, copyInsert, copyInsertLabel, copySelect, executeQuery, executeAllSql, changeQueryPage, refreshQuery, askAI, exportChat, stopGeneration, clearChat, startResize, setEditorSql, formatSql,
            selectRedisKey, loadMetadata,
            workspaceTabs, activeWorkspaceTabId, activeWorkspaceTab, openTableTab, closeWorkspaceTab, closeOtherWorkspaceTabs,
            closeWorkspaceTabsToRight, closeAllWorkspaceTabs, hasWorkspaceTabsToRight, handleWorkspaceTabContextMenu, previewTableData,
            showConfirmModal, confirmPayload, confirmApprove, confirmReject,
            activeTab,
            showImportModal, importSourceId, openImport,

            // 数据编辑功能
            showDataEditModal, dataEditSourceId, dataEditTable, dataEditMode, dataEditData, dataEditColumns, dataEditPrimaryKey,
            openDataEdit, onDataEditSaved,

            // 会话管理功能
            showSessionModal, sessionSourceId, sessionSourceName,
            openSessionManager,

            // 备份功能
            showBackupModal, backupSourceId, backupSourceName, backupTables,
            openBackup, supportsBackup,

            // 搜索功能
            showSearchPanel, searchSourceId, searchTables,
            openSearchPanel, onSelectSearchResult,

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
