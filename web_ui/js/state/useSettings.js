import { t } from '../i18n/index.js';
const { ref, reactive } = Vue;

export function useSettings({ dbService, notify, showMessage, isLoading, refreshTree }) {
    const showConfigModal = ref(false);
    const systemConfig = reactive({ LLM_API_KEY: '', LLM_API_BASE: '', LLM_MODEL: '', LLM_TEMPERATURE: '0.1', LLM_MAX_TOKENS: '8192' });

    const openSettings = async () => {
        try {
            const res = await dbService.getConfig();
            if (res.success) {
                Object.assign(systemConfig, res.config);
                // 后端按字符串存储，数字输入框需要数值
                ['LLM_TEMPERATURE', 'LLM_MAX_TOKENS'].forEach((key) => {
                    const value = Number(systemConfig[key]);
                    systemConfig[key] = Number.isFinite(value) ? value : undefined;
                });
            }
            showConfigModal.value = true;
        } catch (e) {
            showMessage(t('settings.loadFailed', { error: e.message }), t('common.error'), 'error');
        }
    };

    const saveSettings = async () => {
        isLoading.value = true;
        try {
            const res = await dbService.saveConfig(systemConfig);
            if (res.success) {
                notify(t('settings.saved'), 'success');
                showConfigModal.value = false;
            } else {
                showMessage(t('common.saveFailed', { error: res.error }), t('common.error'), 'error');
            }
        } catch (e) {
            showMessage(t('common.saveFailed', { error: e.message }), t('common.error'), 'error');
        } finally {
            isLoading.value = false;
        }
    };

    const exportConfig = async () => {
        isLoading.value = true;
        try {
            const res = await dbService.exportConfig();
            if (!res.success) {
                showMessage(t('settings.loadFailed', { error: res.error || t('common.unknownError') }), t('common.error'), 'error');
                return;
            }
            const configData = JSON.stringify(res.data || { data_sources: [], system_config: {} }, null, 2);
            const filename = `dbdeck-config-and-connections-${Date.now()}.json`;

            if (window.pywebview?.api?.save_json) {
                const saveRes = await window.pywebview.api.save_json(filename, configData);
                if (saveRes?.success) { notify(t('settings.exported'), 'success'); return; }
                if (!saveRes?.cancelled) { showMessage(t('settings.exportFailed', { error: saveRes?.error || t('common.unknownError') }), t('common.error'), 'error'); return; }
                return;
            }

            if (window.showSaveFilePicker) {
                try {
                    const handle = await window.showSaveFilePicker({
                        suggestedName: filename,
                        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
                    });
                    const writable = await handle.createWritable();
                    await writable.write(configData);
                    await writable.close();
                    notify(t('settings.exported'), 'success');
                    return;
                } catch (e) {
                    if (e.name === 'AbortError') return;
                }
            }

            const blob = new Blob([configData], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = filename;
            document.body.appendChild(a); a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            notify(t('settings.exported'), 'success');
        } catch (e) {
            showMessage(t('settings.exportFailed', { error: e.message }), t('common.error'), 'error');
        } finally {
            isLoading.value = false;
        }
    };

    const importConfig = async (parsedData) => {
        if (!parsedData || typeof parsedData !== 'object') {
            showMessage(t('settings.invalidConfigFile'), t('common.error'), 'error');
            return;
        }
        isLoading.value = true;
        try {
            const res = await dbService.importConfig(parsedData);
            if (res.success) {
                notify(t('settings.imported'), 'success');
                showConfigModal.value = false;
                refreshTree();
            } else {
                showMessage(t('settings.importFailed', { error: res.error || t('common.unknownError') }), t('common.error'), 'error');
            }
        } catch (e) {
            showMessage(t('settings.importFailed', { error: e.message }), t('common.error'), 'error');
        } finally {
            isLoading.value = false;
        }
    };

    const handleDbeaverImportResult = (res) => {
        if (res.success) {
            const parsed = res.parsed_count ?? 0;
            const imported = res.imported_count ?? 0;
            const message = res.skipped_count
                ? t('settings.dbeaverImportedSkipped', { imported, parsed, skipped: res.skipped_count })
                : t('settings.dbeaverImported', { imported, parsed });
            notify(message, 'success');
            showConfigModal.value = false;
            refreshTree();
        } else if (!res.cancelled) {
            showMessage(t('settings.dbeaverFailed', { error: res.error || t('common.unknownError') }), t('common.error'), 'error');
        }
    };

    const importDbeaverConfig = async (file) => {
        if (!file) return;
        isLoading.value = true;
        try {
            const res = await dbService.importDbeaverConfig(file);
            handleDbeaverImportResult(res);
        } catch (e) {
            showMessage(t('settings.dbeaverFailed', { error: e.message }), t('common.error'), 'error');
        } finally {
            isLoading.value = false;
        }
    };

    const importDbeaverFile = async () => {
        if (!window.pywebview?.api?.import_dbeaver_file) return;
        isLoading.value = true;
        try {
            const res = await window.pywebview.api.import_dbeaver_file();
            handleDbeaverImportResult(res || {});
        } catch (e) {
            showMessage(t('settings.dbeaverFailed', { error: e.message }), t('common.error'), 'error');
        } finally {
            isLoading.value = false;
        }
    };

    return {
        showConfigModal,
        systemConfig,
        openSettings,
        saveSettings,
        exportConfig,
        importConfig,
        importDbeaverConfig,
        importDbeaverFile,
    };
}
