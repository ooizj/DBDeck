import { t } from '../i18n/index.js';
const { ref, watch, computed } = Vue;

export function useMigration({ dbService, getTree, getProvider, showMessage, showConfirm, isLoading }) {
    const showMigrateModal = ref(false);
    const migrateSourceId = ref(null);
    const migrateDestId = ref(null);
    const migrateTables = ref([]);
    const selectedMigrateTables = ref([]);
    const migrateTablesLoading = ref(false);
    const migrateTablesError = ref('');

    // 只列出 provider 声明支持迁移的连接
    const migrateSources = computed(() => getTree()
        .filter(s => getProvider(s.db_type)?.capabilities?.migrate)
        .map(s => ({ id: s.id, name: s.name, database: s.database, db_type: s.db_type })));

    const tablesFromSource = (source) => (source.children || [])
        .filter(t => (t.object_type || 'table') === 'table')
        .map(t => ({ name: t.name }));

    const handleMigrateSourceChange = async (id) => {
        const numericId = id ? parseInt(id) : null;
        migrateSourceId.value = numericId;
        migrateTables.value = [];
        selectedMigrateTables.value = [];
        migrateTablesError.value = '';
        if (!numericId) return;
        if (migrateDestId.value === numericId) migrateDestId.value = null;

        const source = getTree().find(s => s.id === numericId);
        if (source?.children?.length) {
            migrateTables.value = tablesFromSource(source);
            return;
        }
        // 源连接还没在导航里展开过：单独读取一次表清单
        migrateTablesLoading.value = true;
        try {
            const res = await dbService.getMetadata(numericId);
            if (migrateSourceId.value !== numericId) return;
            if (!res.success) {
                migrateTablesError.value = t('migrate.loadTablesFailed', { error: res.error || t('common.unknownError') });
                return;
            }
            const objectTypes = res.object_types || {};
            migrateTables.value = Object.keys(res.tables || {})
                .filter(name => (objectTypes[name] || 'table') === 'table')
                .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
                .map(name => ({ name }));
        } catch (e) {
            if (migrateSourceId.value === numericId) migrateTablesError.value = t('migrate.loadTablesFailed', { error: e.message });
        } finally {
            if (migrateSourceId.value === numericId) migrateTablesLoading.value = false;
        }
    };

    const doMigrate = async () => {
        const dest = migrateSources.value.find(s => s.id === migrateDestId.value);
        const src = migrateSources.value.find(s => s.id === migrateSourceId.value);
        const count = selectedMigrateTables.value.length;
        const ok = await showConfirm(
            t('migrate.confirm', { count, source: src?.name, target: dest?.name }),
            t('migrate.confirmTitle')
        );
        if (!ok) return;
        isLoading.value = true;
        try {
            const res = await dbService.migrate({ src_id: migrateSourceId.value, dest_id: migrateDestId.value, tables: selectedMigrateTables.value });
            if (res.success === false) {
                showMessage(t('migrate.failed', { error: res.error }), t('migrate.failedTitle'), 'error');
                return;
            }
            const lines = res.details.map(d => (d.result.success
                ? t('migrate.tableOk', { table: d.table })
                : t('migrate.tableFailed', { table: d.table, error: d.result.error })));
            showMessage(`${t('migrate.result')}\n${lines.join('\n')}`, t('migrate.doneTitle'));
            showMigrateModal.value = false;
        } catch (e) {
            showMessage(t('migrate.failed', { error: e.message }), t('common.error'), 'error');
        } finally { isLoading.value = false; }
    };

    // Setup watcher
    const setupWatchers = () => {
        watch(showMigrateModal, (val) => {
            if (val) {
                migrateSourceId.value = null;
                migrateDestId.value = null;
                migrateTables.value = [];
                selectedMigrateTables.value = [];
                migrateTablesLoading.value = false;
                migrateTablesError.value = '';
            }
        });
    };

    return {
        showMigrateModal,
        migrateSourceId,
        migrateDestId,
        migrateTables,
        selectedMigrateTables,
        migrateSources,
        migrateTablesLoading,
        migrateTablesError,
        handleMigrateSourceChange,
        doMigrate,
        setupWatchers,
    };
}
