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
    const showMessage = (msg, title = "提示", type = "info") => {
        const { ElMessageBox } = ElementPlus;
        return ElMessageBox.alert(msg, title, {
            type: _EP_TYPE(type),
            confirmButtonText: "确定",
        }).then(() => true);
    };

    // 返回 Promise<boolean>：确认 -> true，取消 -> false（保留旧实现语义，取消不抛错）
    const showConfirm = (msg, title = "确认") => {
        const { ElMessageBox } = ElementPlus;
        return ElMessageBox.confirm(msg, title, {
            type: "warning",
            confirmButtonText: "确定",
            cancelButtonText: "取消",
        })
            .then(() => true)
            .catch(() => false);
    };

    return { notify, showMessage, showConfirm };
}
