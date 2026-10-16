import ConfirmModal from './ConfirmModal.js';
import SettingsModal from './SettingsModal.js';
import SourceFormModal from './SourceFormModal.js';
import MigrateModal from './MigrateModal.js';
import DDLModal from './DDLModal.js';
import SessionModal from './SessionModal.js';
import BackupModal from './BackupModal.js';
import ExplainModal from './ExplainModal.js';
import CompareModal from './CompareModal.js';

export default {
    components: { ConfirmModal, SettingsModal, SourceFormModal, MigrateModal, DDLModal, SessionModal, BackupModal, ExplainModal, CompareModal },
    props: [
        'showAddModal', 'isEditing', 'newSource', 'isTesting', 'isLoading', 'groupNames',
        'showMigrateModal', 'migrateSourceId', 'migrateDestId', 'migrateTables', 'selectedMigrateTables', 'sources', 'migrateTablesLoading', 'migrateTablesError',
        'showDDLModal', 'ddlTable', 'ddlContent',
        'showConfigModal', 'systemConfig',
        'availableDatabases', 'isDiscovering',
        'showConfirmModal', 'confirmPayload',
        'showSessionModal', 'sessionSourceId', 'sessionSourceName',
        'showBackupModal', 'backupSourceId', 'backupSourceName', 'backupTables',
        'showExplainModal', 'explainSourceId', 'explainQuery',
        'showCompareModal', 'compareSourceId', 'compareSourceType', 'compareTables',
    ],
    emits: [
        'close-add', 'test-connection', 'save-source', 'discover-databases',
        'close-migrate', 'migrate-source-change', 'do-migrate',
        'update:migrateDestId', 'update:selectedMigrateTables',
        'close-ddl', 'copy-ddl',
        'close-config', 'save-config', 'export-config', 'import-config',
        'import-dbeaver-config', 'import-dbeaver-file',
        'confirm-approve', 'confirm-reject',
        'close-session',
        'close-backup',
        'close-explain',
        'close-compare',
    ],
    template: `
        <div>
            <confirm-modal v-if="showConfirmModal"
                :show="showConfirmModal" :confirm-payload="confirmPayload"
                @approve="$emit('confirm-approve')" @reject="$emit('confirm-reject')" />
            <settings-modal v-if="showConfigModal"
                :show="showConfigModal" :system-config="systemConfig" :is-loading="isLoading"
                @close="$emit('close-config')" @save="$emit('save-config')"
                @export-config="$emit('export-config')" @import-config="(d) => $emit('import-config', d)"
                @import-dbeaver-config="(f) => $emit('import-dbeaver-config', f)"
                @import-dbeaver-file="$emit('import-dbeaver-file')" />
            <source-form-modal v-if="showAddModal"
                :show="showAddModal" :is-editing="isEditing" :new-source="newSource"
                :is-testing="isTesting" :is-loading="isLoading"
                :available-databases="availableDatabases" :is-discovering="isDiscovering"
                :group-names="groupNames"
                @close="$emit('close-add')" @test-connection="$emit('test-connection')"
                @save-source="$emit('save-source')" @discover-databases="$emit('discover-databases')" />
            <migrate-modal v-if="showMigrateModal"
                :show="showMigrateModal" :migrate-source-id="migrateSourceId"
                :migrate-dest-id="migrateDestId" :migrate-tables="migrateTables"
                :selected-migrate-tables="selectedMigrateTables" :sources="sources"
                :tables-loading="migrateTablesLoading" :tables-error="migrateTablesError"
                @close="$emit('close-migrate')" @source-change="(id) => $emit('migrate-source-change', id)"
                @update:dest-id="(id) => $emit('update:migrateDestId', id)"
                @update:selected-tables="(t) => $emit('update:selectedMigrateTables', t)"
                @do-migrate="$emit('do-migrate')" />
            <d-d-l-modal v-if="showDDLModal"
                :show="showDDLModal" :table-name="ddlTable" :content="ddlContent"
                @close="$emit('close-ddl')" @copy="(c) => $emit('copy-ddl', c)" />
            <session-modal v-if="showSessionModal"
                :show="showSessionModal" :source-id="sessionSourceId" :source-name="sessionSourceName"
                @close="$emit('close-session')" />
            <backup-modal v-if="showBackupModal"
                :show="showBackupModal" :source-id="backupSourceId" :source-name="backupSourceName"
                :tables="backupTables"
                @close="$emit('close-backup')" />
            <explain-modal
                :show="showExplainModal" :source-id="explainSourceId" :query="explainQuery"
                @close="$emit('close-explain')" />
            <compare-modal v-if="showCompareModal"
                :show="showCompareModal" :source-id="compareSourceId" :tables="compareTables"
                :source-type="compareSourceType"
                @close="$emit('close-compare')" />
        </div>
    `,
};
