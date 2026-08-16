/**
 * 通用模态框状态管理 composable
 * 简化模态框的开关状态管理
 */
import { ref } from 'vue';

export function useModal(initialShow = false) {
    const show = ref(initialShow);
    
    const open = () => {
        show.value = true;
    };
    
    const close = () => {
        show.value = false;
    };
    
    const toggle = () => {
        show.value = !show.value;
    };
    
    return {
        show,
        open,
        close,
        toggle
    };
}

/**
 * 创建多个模态框的状态管理
 * @param {string[]} names - 模态框名称列表
 * @returns {Object} 包含所有模态框的状态和方法
 * 
 * 使用方式：
 * const modals = useModals(['source', 'settings', 'migrate']);
 * modals.source.open();
 * modals.source.show.value; // true
 * modals.source.close();
 */
export function useModals(names) {
    const modals = {};
    
    for (const name of names) {
        const { show, open, close, toggle } = useModal();
        modals[name] = { show, open, close, toggle };
    }
    
    return modals;
}
