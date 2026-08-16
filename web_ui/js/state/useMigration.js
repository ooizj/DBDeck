const { ref, watch } = Vue;

export function useMigration({ dbService, getTree, showMessage, isLoading }) {
    const showMigrateModal = ref(false);
    const migrateSourceId = ref(null);
    const migrateDestId = ref(null);
    const migrateTables = ref([]);
    const selectedMigrateTables = ref([]);

    const handleMigrateSourceChange = (id) => {
        const numericId = id ? parseInt(id) : null;
        migrateSourceId.value = numericId;
        if (numericId) {
            const tree = getTree();
            const source = tree.find(s => s.id === numericId);
            migrateTables.value = source ? (source.children || []) : [];
        } else {
            migrateTables.value = [];
        }
        selectedMigrateTables.value = [];
    };

    const doMigrate = async () => {
        isLoading.value = true;
        try {
            const res = await dbService.migrate({ src_id: migrateSourceId.value, dest_id: migrateDestId.value, tables: selectedMigrateTables.value });
            if (res.success === false) {
                showMessage('迁移失败: ' + res.error, '迁移失败', 'error');
                return;
            }
            const msg = '迁移结果:\n' + res.details.map(d => `${d.table}: ${d.result.success ? '成功' : '失败(' + d.result.error + ')'}`).join('\n');
            showMessage(msg, '迁移完成');
            showMigrateModal.value = false;
        } catch (e) {
            showMessage('迁移请求异常: ' + e.message, '错误', 'error');
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
            }
        });
    };

    return {
        showMigrateModal,
        migrateSourceId,
        migrateDestId,
        migrateTables,
        selectedMigrateTables,
        handleMigrateSourceChange,
        doMigrate,
        setupWatchers,
    };
}
