const { ref, reactive } = Vue;

export function useSettings({ dbService, notify, showMessage, isLoading, refreshTree }) {
    const showConfigModal = ref(false);
    const systemConfig = reactive({ LLM_API_KEY: '', LLM_API_BASE: '', LLM_MODEL: '', LLM_TEMPERATURE: '0.1', LLM_MAX_TOKENS: '8192' });

    const openSettings = async () => {
        try {
            const res = await dbService.getConfig();
            if (res.success) {
                Object.assign(systemConfig, res.config);
            }
            showConfigModal.value = true;
        } catch (e) {
            showMessage('获取配置失败: ' + e.message, '错误', 'error');
        }
    };

    const saveSettings = async () => {
        isLoading.value = true;
        try {
            const res = await dbService.saveConfig(systemConfig);
            if (res.success) {
                notify('设置已保存', 'success');
                showConfigModal.value = false;
            } else {
                showMessage('保存失败: ' + res.error, '错误', 'error');
            }
        } catch (e) {
            showMessage('保存失败: ' + e.message, '错误', 'error');
        } finally {
            isLoading.value = false;
        }
    };

    const exportConfig = async () => {
        isLoading.value = true;
        try {
            const res = await dbService.exportConfig();
            if (!res.success) {
                showMessage('获取配置失败: ' + (res.error || '未知错误'), '错误', 'error');
                return;
            }
            const configData = JSON.stringify(res.data || { data_sources: [], system_config: {} }, null, 2);
            const filename = `dbdeck-config-and-connections-${Date.now()}.json`;

            if (window.pywebview?.api?.save_json) {
                const saveRes = await window.pywebview.api.save_json(filename, configData);
                if (saveRes?.success) { notify('配置与连接已导出', 'success'); return; }
                if (!saveRes?.cancelled) { showMessage('导出失败: ' + (saveRes?.error || '未知错误'), '错误', 'error'); return; }
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
                    notify('配置与连接已导出', 'success');
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
            notify('配置与连接已导出', 'success');
        } catch (e) {
            showMessage('导出失败: ' + e.message, '错误', 'error');
        } finally {
            isLoading.value = false;
        }
    };

    const importConfig = async (parsedData) => {
        if (!parsedData || typeof parsedData !== 'object') {
            showMessage('无效的配置文件格式', '错误', 'error');
            return;
        }
        isLoading.value = true;
        try {
            const res = await dbService.importConfig(parsedData);
            if (res.success) {
                notify('配置已导入并应用', 'success');
                showConfigModal.value = false;
                refreshTree();
            } else {
                showMessage('导入失败: ' + (res.error || '未知错误'), '错误', 'error');
            }
        } catch (e) {
            showMessage('导入失败: ' + e.message, '错误', 'error');
        } finally {
            isLoading.value = false;
        }
    };

    const handleDbeaverImportResult = (res) => {
        if (res.success) {
            const parsed = res.parsed_count ?? 0;
            const imported = res.imported_count ?? 0;
            const skipped = res.skipped_count ? `，跳过 ${res.skipped_count} 个不支持的连接` : '';
            notify(`DBeaver 数据源已导入：新增 ${imported} 个，共解析 ${parsed} 个${skipped}`, 'success');
            showConfigModal.value = false;
            refreshTree();
        } else if (!res.cancelled) {
            showMessage('导入 DBeaver 数据源失败: ' + (res.error || '未知错误'), '错误', 'error');
        }
    };

    const importDbeaverConfig = async (file) => {
        if (!file) return;
        isLoading.value = true;
        try {
            const res = await dbService.importDbeaverConfig(file);
            handleDbeaverImportResult(res);
        } catch (e) {
            showMessage('导入 DBeaver 数据源失败: ' + e.message, '错误', 'error');
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
            showMessage('导入 DBeaver 文件失败: ' + e.message, '错误', 'error');
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
