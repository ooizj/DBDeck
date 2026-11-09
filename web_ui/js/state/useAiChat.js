import { useAiSession } from './useAiSession.js';
import { t, getLocale } from '../i18n/index.js';
import { languageHeaders } from '../api.js';

const { ref, nextTick } = Vue;

// 本地生成的提示消息只存 messageKey，由 AiPanel 按当前界面语言渲染（切换语言后也会跟着变）。
const localMessage = (messageKey, extra = {}) => ({ role: 'ai', content: '', messageKey, ...extra });
export const messageText = (msg) => (msg?.messageKey ? t(msg.messageKey, msg.messageParams) : (msg?.content ?? ''));

const readOnlyEditable = (reason) => ({
    enabled: false,
    sourceId: null,
    table: '',
    primaryKey: null,
    columns: [],
    reason,
});

/**
 * AI 面板：流式对话（NDJSON 事件）、写操作确认、导出和清空。
 */
export function useAiChat({ dbService, getCurrentSource, queryResult, notify, showMessage, showConfirm }) {
    const chatHistory = ref([localMessage('ai.welcome')]);
    const aiInput = ref('');
    const isGenerating = ref(false);
    const showConfirmModal = ref(false);
    const confirmPayload = ref(null);
    const { aiSessionId } = useAiSession();
    let abortController = null;

    const scrollChatToBottom = () => {
        nextTick(() => {
            const box = document.querySelector('.ai-chat');
            if (box) box.scrollTop = box.scrollHeight;
        });
    };

    const applyFinalData = (data) => {
        const currentSource = getCurrentSource();
        if (!data) return;
        if (data.source_id !== undefined && data.source_id !== null && currentSource?.id !== data.source_id) return;
        Object.assign(queryResult, {
            columns: data.columns || [],
            column_metadata: data.column_metadata || {},
            rows: data.data || [],
            rowCount: data.row_count,
            time: 'AI',
            durationMs: data.duration_ms ?? null,
            executedSql: data.executed_queries?.length ? data.executed_queries.join('\n') : data.executed_sql,
            operationKind: data.operation_kind || '',
            statements: data.statements || [],
            activeStatementIndex: data.active_statement_index || 0,
            editable: readOnlyEditable('edit.reasonAiResult'),
        });
    };

    const handleAIEvent = (e) => {
        const lastMsg = chatHistory.value[chatHistory.value.length - 1];
        if (e.type === 'delta') {
            if (lastMsg && lastMsg.role === 'ai' && !lastMsg.isFinal) {
                lastMsg.content += e.content;
            } else {
                chatHistory.value.push({ role: 'ai', content: e.content, isFinal: false, collapsed: false });
            }
        } else if (e.type === 'tool_start') {
            chatHistory.value.push({ role: 'tool_log', tool: e.tool, args: e.args, done: false });
        } else if (e.type === 'tool_end') {
            const log = [...chatHistory.value].reverse().find(m => m.role === 'tool_log' && m.tool === e.tool && !m.done);
            if (log) {
                log.done = true;
                log.result = e.result;
            }
        } else if (e.type === 'confirm_required') {
            confirmPayload.value = { pending_id: e.pending_id, calls: e.calls };
            showConfirmModal.value = true;
        } else if (e.type === 'final') {
            if (lastMsg && lastMsg.role === 'ai' && !lastMsg.isFinal) {
                lastMsg.isFinal = true;
                if (e.queries && e.queries.length) lastMsg.queries = e.queries;
                else delete lastMsg.queries;
                if (e.sql) lastMsg.sql = e.sql;
                else delete lastMsg.sql;
                if (!lastMsg.content || lastMsg.content.trim() === '') lastMsg.content = e.answer;
            } else {
                const newMsg = { role: 'ai', content: e.answer, isFinal: true, collapsed: false };
                if (e.queries && e.queries.length) newMsg.queries = e.queries;
                if (e.sql) newMsg.sql = e.sql;
                chatHistory.value.push(newMsg);
            }
            applyFinalData(e.data);
        } else if (e.type === 'error') {
            chatHistory.value.push(localMessage('ai.errorMessage', { messageParams: { error: e.message }, isFinal: true, isError: true }));
        }
        scrollChatToBottom();
    };

    const runQuery = async (queryText, { showAsUser = true } = {}) => {
        if (isGenerating.value) return;
        isGenerating.value = true;
        abortController = new AbortController();
        if (showAsUser) chatHistory.value.push({ role: 'user', content: queryText });
        try {
            const response = await fetch('/api/query', {
                method: 'POST', headers: { 'Content-Type': 'application/json', ...languageHeaders() },
                body: JSON.stringify({
                    query: queryText,
                    source_id: getCurrentSource()?.id,
                    session_id: aiSessionId
                }),
                signal: abortController.signal
            });
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();
                for (const line of lines) { if (line.trim()) handleAIEvent(JSON.parse(line)); }
            }
        } catch (e) {
            if (e.name === 'AbortError') chatHistory.value.push(localMessage('ai.stopped', { isFinal: true, collapsed: false }));
            else chatHistory.value.push(localMessage('ai.errorMessage', { messageParams: { error: e.message }, isFinal: true, isError: true }));
        } finally { isGenerating.value = false; abortController = null; }
    };

    const askAI = async () => {
        const input = aiInput.value.trim();
        if (!input || isGenerating.value) return;
        aiInput.value = '';
        await runQuery(input);
    };

    const confirmApprove = async () => {
        if (!confirmPayload.value) return;
        const pid = confirmPayload.value.pending_id;
        const calls = confirmPayload.value.calls;
        showConfirmModal.value = false;
        chatHistory.value.push({
            role: 'ai',
            content: '',
            messageKey: 'ai.userApproved',
            messageParams: { tools: calls.map(c => c.tool).join(', ') },
            isFinal: true,
            isSystem: true
        });
        confirmPayload.value = null;
        await runQuery(`__confirm__:${pid}:approve`, { showAsUser: false });
    };

    const confirmReject = async () => {
        if (!confirmPayload.value) return;
        const pid = confirmPayload.value.pending_id;
        showConfirmModal.value = false;
        chatHistory.value.push({
            role: 'ai',
            content: '',
            messageKey: 'ai.userRejected',
            isFinal: true,
            isSystem: true
        });
        confirmPayload.value = null;
        await runQuery(`__confirm__:${pid}:reject`, { showAsUser: false });
    };

    const buildChatMarkdown = () => {
        const currentSource = getCurrentSource();
        let markdown = `# ${t('aiExport.title')}\n\n`;
        markdown += `${t('aiExport.exportedAt', { time: new Date().toLocaleString(getLocale() === 'zh' ? 'zh-CN' : 'en-US') })}\n\n`;
        if (currentSource) {
            markdown += `${t('aiExport.source', { name: currentSource.name, database: currentSource.database })}\n\n`;
        }
        markdown += '---\n\n';
        let messageIndex = 0;
        chatHistory.value.forEach((msg, idx) => {
            if (msg.role === 'user') {
                messageIndex++;
                markdown += `## ${t('aiExport.user')} (${messageIndex})\n\n${messageText(msg)}\n\n`;
            } else if (msg.role === 'ai') {
                messageIndex++;
                markdown += `## ${t('ai.title')} (${messageIndex})\n\n${messageText(msg)}\n\n`;
                if (msg.queries?.length) markdown += `**${t('aiExport.queries')}**\n\`\`\`\n${msg.queries.join('\n')}\n\`\`\`\n\n`;
                else if (msg.sql) markdown += `**${t('aiExport.queries')}**\n\`\`\`\n${msg.sql}\n\`\`\`\n\n`;

                const isLastMsg = (idx === chatHistory.value.length - 1);
                if (!msg.isFinal && isLastMsg) {
                    markdown += `_${t('aiExport.incomplete')}_\n\n`;
                }
            } else if (msg.role === 'tool_log') {
                markdown += `> 🛠️ **${t('aiExport.toolCall')}**: \`${msg.tool}\` (${msg.done ? t('ai.toolDone') : t('ai.toolRunning')})\n`;
                if (msg.args) {
                    markdown += `> * **${t('aiExport.args')}**:\n>   \`\`\`json\n>   ${JSON.stringify(msg.args, null, 2).split('\n').join('\n>   ')}\n>   \`\`\`\n`;
                }
                if (msg.result) {
                    markdown += `> * **${t('aiExport.result')}**:\n>   \`\`\`json\n>   ${JSON.stringify(msg.result, null, 2).split('\n').join('\n>   ')}\n>   \`\`\`\n`;
                }
                markdown += `\n`;
            }
        });
        return markdown;
    };

    const exportChat = async () => {
        const markdown = buildChatMarkdown();
        const filename = `chat-export-${Date.now()}.md`;
        if (window.pywebview?.api?.save_markdown) {
            try {
                const res = await window.pywebview.api.save_markdown(filename, markdown);
                if (res?.success) {
                    notify(t('ai.exported'), 'success');
                } else if (!res?.cancelled) {
                    showMessage(t('settings.exportFailed', { error: res?.error || t('common.unknownError') }), t('common.error'), 'error');
                }
                return;
            } catch (e) {
                showMessage(t('settings.exportFailed', { error: e.message }), t('common.error'), 'error');
                return;
            }
        }

        if (window.showSaveFilePicker) {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: filename,
                    types: [{
                        description: 'Markdown',
                        accept: { 'text/markdown': ['.md'] },
                    }],
                });
                const writable = await handle.createWritable();
                await writable.write(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
                await writable.close();
                notify(t('ai.exported'), 'success');
                return;
            } catch (e) {
                if (e.name === 'AbortError') return;
                showMessage(t('settings.exportFailed', { error: e.message }), t('common.error'), 'error');
                return;
            }
        }

        const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        notify(t('ai.exported'), 'success');
    };

    const stopGeneration = () => {
        if (abortController) {
            abortController.abort();
            abortController = null;
        }
    };

    /** 关闭/删除当前数据源时调用：中断请求并立即解除生成中状态。 */
    const cancelGeneration = () => {
        stopGeneration();
        isGenerating.value = false;
    };

    const clearChat = async () => {
        if (await showConfirm(t('ai.newChatConfirm'))) {
            try {
                await dbService.clearChat(aiSessionId);
                chatHistory.value = [localMessage('ai.cleared')];
                notify(t('ai.clearedToast'), 'success');
            } catch (e) {
                showMessage(t('history.clearFailed', { error: e.message }), t('common.error'), 'error');
            }
        }
    };

    return {
        chatHistory,
        aiInput,
        isGenerating,
        showConfirmModal,
        confirmPayload,
        askAI,
        confirmApprove,
        confirmReject,
        exportChat,
        stopGeneration,
        cancelGeneration,
        clearChat,
    };
}
