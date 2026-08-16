/**
 * 通用模态框壳组件
 * 提供统一的 overlay、content 容器、header、footer 结构
 */
export default {
    name: 'ModalShell',
    props: {
        show: { type: Boolean, default: false },
        title: { type: String, default: '' },
        width: { type: String, default: '600px' },
        maxWidth: { type: String, default: '90vw' },
        maxHeight: { type: String, default: '85vh' },
        showClose: { type: Boolean, default: true },
        closeOnOverlay: { type: Boolean, default: true }
    },
    emits: ['close'],
    template: `
        <div v-if="show" class="modal-overlay" @click.self="closeOnOverlay && $emit('close')">
            <div class="modal-content modal-shell" :style="{ width, maxWidth, maxHeight }">
                <div class="modal-header" v-if="title || $slots.header">
                    <slot name="header">
                        <h3>{{ title }}</h3>
                    </slot>
                    <div class="modal-actions">
                        <slot name="actions"></slot>
                        <button v-if="showClose" class="btn-close" @click="$emit('close')">&times;</button>
                    </div>
                </div>
                
                <div class="modal-body">
                    <slot></slot>
                </div>
                
                <div class="modal-footer" v-if="$slots.footer">
                    <slot name="footer"></slot>
                </div>
            </div>
        </div>
    `
};
