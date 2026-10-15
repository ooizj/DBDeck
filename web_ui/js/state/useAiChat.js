import { useAiSession } from './useAiSession.js';

const { ref, nextTick } = Vue;

const WELCOME_MESSAGE = '欢迎来到 DBDeck。选择左侧连接后，可以让我解释结构、生成查询或分析结果。';

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
    const chatHistory = ref([{ role: 'ai', content: WELCOME_MESSAGE }]);
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
            editable: readOnlyEditable('AI 查询结果默认只读'),
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
            chatHistory.value.push({ role: 'ai', content: '❌ 错误: ' + e.message, isFinal: true, isError: true });
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
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: queryText,
                    source_id: getCurrentSource()?.id,
                    workspace_id: null,
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
            if (e.name === 'AbortError') chatHistory.value.push({ role: 'ai', content: '已停止生成。', isFinal: true, collapsed: false });
            else chatHistory.value.push({ role: 'ai', content: '错误: ' + e.message });
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
            content: `✓ 用户已确认：${calls.map(c => c.tool).join(', ')}`,
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
            content: '✗ 用户已拒绝执行该批次操作。',
            isFinal: true,
            isSystem: true
        });
        confirmPayload.value = null;
        await runQuery(`__confirm__:${pid}:reject`, { showAsUser: false });
    };

    const buildChatMarkdown = () => {
        const currentSource = getCurrentSource();
        let markdown = '# 数据库客户端 AI 对话记录\n\n';
        markdown += `导出时间: ${new Date().toLocaleString('zh-CN')}\n\n`;
        if (currentSource) {
            markdown += `数据源: ${currentSource.name} (${currentSource.database})\n\n`;
        }
        markdown += '---\n\n';
        let messageIndex = 0;
        chatHistory.value.forEach((msg, idx) => {
            if (msg.role === 'user') {
                messageIndex++;
                markdown += `## 用户 (${messageIndex})\n\n${msg.content}\n\n`;
            } else if (msg.role === 'ai') {
                messageIndex++;
                markdown += `## AI 助手 (${messageIndex})\n\n${msg.content}\n\n`;
                if (msg.queries?.length) markdown += `**执行的查询:**\n\`\`\`\n${msg.queries.join('\n')}\n\`\`\`\n\n`;
                else if (msg.sql) markdown += `**执行的查询:**\n\`\`\`\n${msg.sql}\n\`\`\`\n\n`;

                const isLastMsg = (idx === chatHistory.value.length - 1);
                if (!msg.isFinal && isLastMsg) {
                    markdown += `_（此消息可能未完成或被中断）_\n\n`;
                }
            } else if (msg.role === 'tool_log') {
                markdown += `> 🛠️ **工具调用**: \`${msg.tool}\` (${msg.done ? '已完成' : '执行中'})\n`;
                if (msg.args) {
                    markdown += `> * **请求参数**:\n>   \`\`\`json\n>   ${JSON.stringify(msg.args, null, 2).split('\n').join('\n>   ')}\n>   \`\`\`\n`;
                }
                if (msg.result) {
                    markdown += `> * **返回结果**:\n>   \`\`\`json\n>   ${JSON.stringify(msg.result, null, 2).split('\n').join('\n>   ')}\n>   \`\`\`\n`;
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
                    notify('聊天记录已导出', 'success');
                } else if (!res?.cancelled) {
                    showMessage('导出失败: ' + (res?.error || '未知错误'), '错误', 'error');
                }
                return;
            } catch (e) {
                showMessage('导出失败: ' + e.message, '错误', 'error');
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
                notify('聊天记录已导出', 'success');
                return;
            } catch (e) {
                if (e.name === 'AbortError') return;
                showMessage('导出失败: ' + e.message, '错误', 'error');
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
        notify('聊天记录已导出', 'success');
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
        if (await showConfirm('确定要清空对话历史吗？')) {
            try {
                await dbService.clearChat(aiSessionId);
                chatHistory.value = [{ role: 'ai', content: '对话已清空，请开始新的对话。' }];
                notify('对话已清空', 'success');
            } catch (e) {
                showMessage('清空失败: ' + e.message, '错误', 'error');
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
