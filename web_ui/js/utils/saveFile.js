import { t } from '../i18n/index.js';
// 大文件直接展开 String.fromCharCode(...bytes) 会超出调用栈，分块转换
export function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

/** 导出文件名加上本地时间，如 query-result_20261103_162240.csv，避免多次导出互相覆盖。 */
export function timestampedFilename(base, ext, now = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `${base}_${date}_${time}.${ext}`;
}

/**
 * 保存导出文件：桌面版走 pywebview 原生保存框，浏览器优先用 showSaveFilePicker，否则直接下载。
 * content 以 "base64:" 开头时按二进制内容处理（如 XLSX）。
 */
export async function saveFile(content, filename, fileTypes) {
    if (window.pywebview?.api?.save_file) {
        try {
            const res = await window.pywebview.api.save_file(filename, content, fileTypes || '');
            if (res?.success) {
                ElementPlus.ElMessage.success(t('file.savedTo', { path: res.path }));
                return;
            }
            if (res?.cancelled) return;
            ElementPlus.ElMessage.error(t('common.saveFailed', { error: res?.error || t('common.unknownError') }));
            return;
        } catch (e) {
            ElementPlus.ElMessage.error(t('common.saveFailed', { error: e.message }));
            return;
        }
    }
    if (window.showSaveFilePicker && !content.startsWith('base64:')) {
        try {
            const handle = await window.showSaveFilePicker({
                suggestedName: filename,
                types: [{ description: 'Data', accept: { 'application/octet-stream': [filename.replace(/.*\./, '.')] } }],
            });
            const writable = await handle.createWritable();
            await writable.write(new Blob([content], { type: 'text/plain;charset=utf-8' }));
            await writable.close();
            ElementPlus.ElMessage.success(t('file.saved'));
            return;
        } catch (e) {
            if (e.name === 'AbortError') return;
        }
    }
    const blob = content.startsWith('base64:')
        ? new Blob([Uint8Array.from(atob(content.slice(7)), c => c.charCodeAt(0))])
        : new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    ElementPlus.ElMessage.success(t('file.downloadStarted'));
}
