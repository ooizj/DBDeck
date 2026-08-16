export default {
    props: {
        show: Boolean,
        confirmPayload: Object,
    },
    emits: ['approve', 'reject'],
    data() {
        return {
            expandedCalls: {},
        };
    },
    methods: {
        toggleExpandCall(index) {
            this.expandedCalls[index] = !this.expandedCalls[index];
        },
        getFileSummary(content) {
            if (!content) return '';
            const lines = content.split('\n');
            if (lines.length <= 15) return content;
            return lines.slice(0, 15).join('\n') + '\n\n... (已省略其余 ' + (lines.length - 15) + ' 行，点击上方按钮展开完整内容) ...';
        },
        isWriteFileTool(tool) {
            return tool && (tool.endsWith('write_file') || tool.endsWith('write_to_file'));
        },
        isEditFileTool(tool) {
            return tool && (tool.endsWith('edit_file') || tool.endsWith('replace_file_content') || tool.endsWith('multi_replace_file_content'));
        },
        getLineCount(content) {
            if (!content) return 0;
            return content.split('\n').length;
        },
    },
    template: `
        <el-dialog
            :model-value="show"
            @update:model-value="$emit('reject')"
            width="680px"
            :close-on-click-modal="false"
            :show-close="false"
            destroy-on-close
            append-to-body
        >
            <template #header><span style="font-size: 18px;">⚠️ 确认执行 AI 操作</span></template>
            <div style="max-height: 450px; overflow-y: auto; padding-right: 4px;">
                    <div v-for="(call, i) in (confirmPayload?.calls || [])" :key="i"
                         style="margin-bottom: 16px; padding: 14px; border: 1px solid var(--border-slate); background: var(--surface-bg); border-radius: 6px; box-shadow: 0 2px 8px rgba(1,4,9,0.4);">
                        <!-- 标题/工具类型 badge -->
                        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;">
                            <div style="font-size: 14px; font-weight: 600; color: var(--text); font-family: monospace;">
                                🛠️ {{ call.tool }}
                            </div>
                            <span v-if="isWriteFileTool(call.tool)" style="background: rgba(68,147,248,0.15); color: #79c0ff; border: 1px solid rgba(68,147,248,0.4); font-size: 11px; padding: 2px 6px; border-radius: 3px; font-weight: bold;">
                                写入文件
                            </span>
                            <span v-else-if="isEditFileTool(call.tool)" style="background: rgba(114,46,209,0.18); color: #b392f0; border: 1px solid rgba(114,46,209,0.4); font-size: 11px; padding: 2px 6px; border-radius: 3px; font-weight: bold;">
                                修改文件
                            </span>
                            <span v-else style="background: rgba(210,153,34,0.15); color: #d29922; border: 1px solid rgba(210,153,34,0.4); font-size: 11px; padding: 2px 6px; border-radius: 3px; font-weight: bold;">
                                通用操作
                            </span>
                        </div>

                        <!-- 写入文件专用布局 -->
                        <div v-if="isWriteFileTool(call.tool)">
                            <div style="background: var(--panel-bg); border: 1px solid var(--border-slate); padding: 8px 12px; border-radius: 4px; font-family: monospace; font-size: 12px; color: var(--text); margin-bottom: 8px; border-left: 4px solid var(--accent); word-break: break-all;">
                                📁 <strong>目标路径:</strong> {{ call.args.path || call.args.TargetFile }}
                            </div>
                            <div style="margin-top: 8px;">
                                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                                    <span style="font-size: 12px; color: var(--text-secondary); font-weight: 500;">
                                        📄 文件内容预览 (共 {{ getLineCount(call.args.content || call.args.CodeContent) }} 行)
                                    </span>
                                    <el-button text size="small" @click="toggleExpandCall(i)">
                                        {{ expandedCalls[i] ? '折叠内容' : '展开完整内容' }}
                                    </el-button>
                                </div>
                                <pre style="margin: 0; font-size: 12px; white-space: pre-wrap; word-break: break-all; background: #0d1117; color: #d4d4d4; padding: 12px; border-radius: 4px; max-height: 250px; overflow-y: auto; font-family: 'Consolas', 'Courier New', monospace; border: 1px solid var(--border-slate);">{{ expandedCalls[i] ? (call.args.content || call.args.CodeContent) : getFileSummary(call.args.content || call.args.CodeContent) }}</pre>
                            </div>
                        </div>

                        <!-- 修改文件专用布局 -->
                        <div v-else-if="isEditFileTool(call.tool)">
                            <div style="background: var(--panel-bg); border: 1px solid var(--border-slate); padding: 8px 12px; border-radius: 4px; font-family: monospace; font-size: 12px; color: var(--text); margin-bottom: 8px; border-left: 4px solid #b392f0; word-break: break-all;">
                                📁 <strong>目标路径:</strong> {{ call.args.path || call.args.TargetFile }}
                            </div>
                            <div style="margin-top: 8px;">
                                <div style="font-size: 12px; color: var(--text-secondary); font-weight: 500; margin-bottom: 6px;">✏️ 代码修改段落:</div>
                                <div v-if="call.args.ReplacementChunks || call.args.TargetContent">
                                    <div v-for="(chunk, idx) in (call.args.ReplacementChunks || [{ TargetContent: call.args.TargetContent, ReplacementContent: call.args.ReplacementContent, StartLine: call.args.StartLine, EndLine: call.args.EndLine }])" :key="idx"
                                         style="border: 1px solid var(--border-slate); border-radius: 4px; overflow: hidden; margin-bottom: 10px; background: var(--panel-bg);">
                                        <div style="background: rgba(248,81,73,0.12); color: #ff7875; padding: 6px 10px; font-size: 11px; font-weight: bold; border-bottom: 1px solid rgba(248,81,73,0.3); display: flex; justify-content: space-between;">
                                            <span>- 待替换的原代码:</span>
                                            <span v-if="chunk.StartLine">第 {{ chunk.StartLine }} - {{ chunk.EndLine }} 行</span>
                                        </div>
                                        <pre style="margin: 0; font-size: 11px; white-space: pre-wrap; word-break: break-all; background: rgba(248,81,73,0.06); color: #ff7875; padding: 8px; font-family: monospace; max-height: 120px; overflow-y: auto;">{{ chunk.TargetContent }}</pre>
                                        <div style="background: rgba(63,185,80,0.12); color: #56d364; padding: 6px 10px; font-size: 11px; font-weight: bold; border-top: 1px solid var(--border-slate); border-bottom: 1px solid rgba(63,185,80,0.3);">
                                            + 替换后的新代码:
                                        </div>
                                        <pre style="margin: 0; font-size: 11px; white-space: pre-wrap; word-break: break-all; background: rgba(63,185,80,0.06); color: #56d364; padding: 8px; font-family: monospace; max-height: 150px; overflow-y: auto;">{{ chunk.ReplacementContent }}</pre>
                                    </div>
                                </div>
                                <div v-else-if="call.args.Instruction">
                                    <div style="font-size: 12px; color: var(--text); background: var(--panel-bg); padding: 8px 12px; border: 1px solid var(--border-slate); border-radius: 4px;">
                                        <strong>修改指令:</strong> {{ call.args.Instruction }}
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- 通用参数渲染布局 -->
                        <div v-else>
                            <table style="width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 12px; background: var(--panel-bg); border-radius: 4px; overflow: hidden;">
                                <tbody>
                                    <tr v-for="(val, key) in call.args" :key="key" style="border-bottom: 1px solid var(--border-slate);">
                                        <td style="padding: 6px 10px; font-weight: 600; color: var(--text-secondary); width: 120px; background: var(--surface-bg); border: 1px solid var(--border-slate); font-family: monospace; vertical-align: top;">
                                            {{ key }}
                                        </td>
                                        <td style="padding: 6px 10px; color: var(--text); border: 1px solid var(--border-slate); font-family: monospace; white-space: pre-wrap; word-break: break-all; font-size: 11px;">
                                            {{ typeof val === 'object' ? JSON.stringify(val, null, 2) : val }}
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
                <template #footer>
                    <el-button @click="$emit('reject')">✗ 拒绝</el-button>
                    <el-button type="warning" @click="$emit('approve')">✓ 确认执行</el-button>
                </template>
        </el-dialog>
    `,
};
