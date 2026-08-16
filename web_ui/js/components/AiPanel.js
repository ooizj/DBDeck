export default {
    props: ['chatHistory', 'modelValue', 'isGenerating', 'aiWidth'],
    emits: ['update:modelValue', 'ask', 'stop', 'clear', 'export', 'set-sql', 'copy'],
    data() {
        return {
            isComposing: false,
            lastCompositionEnd: 0
        };
    },
    watch: {
        isGenerating(newVal, oldVal) {
            if (!newVal && oldVal) {
                this.$nextTick(() => {
                    const el = this.$refs.aiInput;
                    if (el) el.focus();
                });
            }
        }
    },
    methods: {
        escapeHtml(value) {
            return String(value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        },
        parseMessage(c) {
            if (!c) return '';
            const escaped = this.escapeHtml(c);
            let h = escaped.replace(/[\n\s]*&lt;(think|thought|thinking)&gt;([\s\S]*?)&lt;\/\1&gt;[\n\s]*/g, (m, t, content) =>
                `<details class="ai-think"><summary>思考过程 (点击展开)</summary><div class="ai-think-content">${content.trim()}</div></details>`
            );
            return h.trim().replace(/\n/g, '<br>');
        },
        handleEnter(event) {
            // 如果正在使用输入法拼写中，或者在拼写结束的 100ms 内（解决 WebKit 拼写结束触发 Enter 误发送的 bug），则不发送
            const now = Date.now();
            if (this.isComposing || event.isComposing || (now - this.lastCompositionEnd < 100)) {
                return;
            }
            this.$emit('ask');
        },
        handleCompositionEnd(event) {
            this.isComposing = false;
            this.lastCompositionEnd = Date.now();
        }
    },
    mounted() {
        this.$nextTick(() => {
            const el = this.$refs.aiInput;
            if (el) el.focus();
        });
    },
    template: `
        <div class="ai-panel" :style="{ width: aiWidth + 'px' }">
            <div class="ai-header">
                <div>
                    <div class="ai-title-main">AI Assistant</div>
                    <div class="ai-title-sub">Schema, SQL, analysis</div>
                </div>
                <div style="display: flex; gap: 8px; align-items: center;">
                    <button class="header-btn" @click="$emit('clear')" title="新建对话">新建</button>
                    <button v-if="chatHistory.length > 1" class="header-btn" @click="$emit('export')" title="导出聊天记录">导出</button>
                    <button v-if="isGenerating" class="stop-btn-mini" @click="$emit('stop')">停止</button>
                </div>
            </div>
            <div class="ai-chat" ref="chatBox">
                <div v-for="(msg, i) in chatHistory" :key="i" :class="['chat-message', msg.role]">
                    <div v-if="msg.role !== 'tool_log'" class="chat-bubble" :class="{ collapsed: msg.collapsed, error: msg.isError }" @click="msg.role === 'ai' && msg.collapsed && (msg.collapsed = false)">
                        <div class="chat-header" v-if="msg.role === 'ai'" @click.stop="msg.collapsed = !msg.collapsed">
                            <span class="ai-title">AI 助手</span>
                            <span class="expand-hint" v-if="msg.collapsed">点击展开</span>
                            <span class="collapse-icon" v-else>折叠</span>
                        </div>
                        <div v-if="msg.role === 'ai'" v-show="!msg.collapsed" v-html="parseMessage(msg.content)"></div>
                        <div v-else>{{ msg.content }}</div>
                        <div v-if="((msg.queries && msg.queries.length) || msg.sql) && !msg.collapsed" class="ai-sql-preview">
                            <code>{{ msg.queries && msg.queries.length ? msg.queries.join('\\n') : msg.sql }}</code>
                            <button class="copy-sql-btn" @click.stop="$emit('copy', msg.queries && msg.queries.length ? msg.queries.join('\\n') : msg.sql)">
                                <span style="margin-right: 4px;">📋</span> Copy SQL
                            </button>
                        </div>
                    </div>
                    <div v-else :class="['skill-log', { success: msg.done }]">
                        <span class="icon">{{ msg.done ? '✓' : '⚙' }}</span>
                        <span class="type-tag">Tool</span>
                        <span>{{ msg.done ? 'Executed' : 'Executing' }} <b>{{ msg.tool }}</b></span>
                    </div>
                </div>
            </div>
            <div class="ai-input-area">
                <div class="ai-input-wrapper">
                    <textarea ref="aiInput" class="ai-input" 
                        :value="modelValue" 
                        @input="$emit('update:modelValue', $event.target.value)"
                        @compositionstart="isComposing = true"
                        @compositionend="handleCompositionEnd"
                        @keydown.enter.exact.prevent="handleEnter" 
                        :disabled="isGenerating" 
                        placeholder="询问 AI... (Enter 发送, Shift+Enter 换行)"></textarea>
                    <button class="toolbar-btn primary" @click="$emit('ask')" :disabled="!modelValue.trim() || isGenerating">发送</button>
                </div>
            </div>
        </div>
    `
};
