import { t } from '../i18n/index.js';
// 通知 / 确认对话框统一委托到 Element Plus 的 ElMessage / ElMessageBox。
// 保持原 useNotifications 的 notify / showMessage / showConfirm 函数签名不变，
// 调用方（app.js 及各组件、作为 props 传入的 ImportPanel 等）无需任何改动，
// 全应用的提示样式即与 Element Plus 一致，不再需要自研的通知/对话框 DOM 与响应式状态。
// ElementPlus 由 index.html 的 vendor 脚本挂到全局，这里按需懒取以防加载顺序问题。

const _EP_TYPE = (type) =>
    ["success", "warning", "error", "info"].includes(type) ? type : "info";

export function useNotifications() {
    const notify = (message, type = "info") => {
        const { ElMessage } = ElementPlus;
        ElMessage[_EP_TYPE(type)]({ message, duration: 3000 });
    };

    // 返回 Promise<true>（与旧实现一致：用户点击确定后 resolve true）
    const showMessage = (msg, title = t("common.notice"), type = "info") => {
        const { ElMessageBox } = ElementPlus;
        return ElMessageBox.alert(msg, title, {
            type: _EP_TYPE(type),
            confirmButtonText: t("common.ok"),
        }).then(() => true);
    };

    // 返回 Promise<boolean>：确认 -> true，取消 -> false（保留旧实现语义，取消不抛错）
    const showConfirm = (msg, title = t("common.confirm")) => {
        const { ElMessageBox } = ElementPlus;
        return ElMessageBox.confirm(msg, title, {
            type: "warning",
            confirmButtonText: t("common.ok"),
            cancelButtonText: t("common.cancel"),
        })
            .then(() => true)
            .catch(() => false);
    };

    // 返回 Promise<string|null>：确定 -> 输入的文本，取消 -> null
    const showPrompt = (msg, title = t("common.input"), { inputValue = "", placeholder = "" } = {}) => {
        const { ElMessageBox } = ElementPlus;
        return ElMessageBox.prompt(msg, title, {
            confirmButtonText: t("common.ok"),
            cancelButtonText: t("common.cancel"),
            inputValue,
            inputPlaceholder: placeholder,
        })
            .then(({ value }) => value ?? "")
            .catch(() => null);
    };

    return { notify, showMessage, showConfirm, showPrompt };
}
