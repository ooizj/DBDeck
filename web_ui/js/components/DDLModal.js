export default {
    props: {
        show: { type: Boolean, default: false },
        tableName: { type: String, default: '' },
        content: { type: String, default: '' },
    },
    emits: ['close', 'copy'],
    template: `
        <el-dialog
            :model-value="show"
            @update:model-value="$emit('close')"
            :title="'DDL - ' + tableName"
            width="720px"
            :close-on-click-modal="true"
            destroy-on-close
            append-to-body
        >
            <el-input
                type="textarea"
                :model-value="content"
                readonly
                :autosize="{ minRows: 18, maxRows: 24 }"
                resize="none"
                style="font-family: 'Consolas', 'Courier New', monospace; font-size: 13px;"
            />
            <template #footer>
                <el-button @click="$emit('close')">关闭</el-button>
                <el-button type="primary" @click="$emit('copy', content)">复制内容</el-button>
            </template>
        </el-dialog>
    `,
};
