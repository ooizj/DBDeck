import { splitSqlStatementsWithOffsets } from '../utils/sqlHelpers.js';
import { updateEditorReadOnly } from '../utils/editorState.js';

const { watch } = Vue;

/**
 * SQL 控制台的 Monaco 编辑器：初始化、按数据源切换语言与补全、格式化、脚本自动保存。
 */
export function useSqlEditor({
    dbService,
    getCurrentSource,
    getCurrentProvider,
    getCurrentTables,
    getProvider,
    isReadOnly,
    notify,
}) {
    let editor = null;
    let autoSaveTimer = null;
    let suggestDetailsTimer = null;
    let isApplyingScript = false;
    // 已注册过 completion provider 的 Monaco language id，避免重复注册
    const registeredLanguages = new Set();
    // 每个数据源 provider 各自的补全实现（MySQL/PostgreSQL/SQLite 共用 Monaco 的 mysql 语言，需按当前 provider 分派）
    const providerCompletions = new Map();

    watch(isReadOnly, readOnly => updateEditorReadOnly(editor, readOnly));

    const getEditor = () => editor;
    const getValue = () => (editor ? editor.getValue() : '');
    const setValue = (sql) => {
        if (editor) editor.setValue(sql || '');
    };
    const layout = () => {
        if (editor) editor.layout();
    };

    const applyEditorLanguage = () => {
        const source = getCurrentSource();
        if (!editor || !source) return;
        const provider = getProvider(source.db_type);
        monaco.editor.setModelLanguage(editor.getModel(), provider.editorLanguage);
    };

    const setEditorScript = (content) => {
        if (!editor) return;
        isApplyingScript = true;
        try {
            editor.setValue(content || '');
            applyEditorLanguage();
        } finally {
            isApplyingScript = false;
        }
    };

    const loadSourceScript = async (source) => {
        if (!source || !editor) return;
        try {
            const res = await dbService.getScript(source.id);
            if (res.success) setEditorScript(res.content || '');
        } catch (e) {
            console.error('Failed to fetch script', e);
        }
    };

    const saveCurrentSourceScript = async () => {
        const source = getCurrentSource();
        if (!source || !editor) return;
        if (autoSaveTimer) {
            clearTimeout(autoSaveTimer);
            autoSaveTimer = null;
        }
        try {
            await dbService.saveScript(source.id, editor.getValue());
        } catch (e) {
            console.error('Failed to save script', e);
        }
    };

    const completionForProvider = (provider) => {
        if (!provider) return null;
        if (!providerCompletions.has(provider.id)) {
            const completion = provider.registerCompletion(monaco, {
                getCurrentTables,
                getCurrentSource,
                getModelText: getValue,
            });
            providerCompletions.set(provider.id, completion?.provideCompletionItems ? completion : null);
        }
        return providerCompletions.get(provider.id);
    };

    const ensureCompletionRegistered = () => {
        const currentProvider = getCurrentProvider();
        if (!editor || !currentProvider) return;
        const lang = currentProvider.editorLanguage;
        if (registeredLanguages.has(lang)) return;
        const completion = completionForProvider(currentProvider);
        if (!completion) return;
        monaco.languages.registerCompletionItemProvider(lang, {
            triggerCharacters: completion.triggerCharacters,
            provideCompletionItems: (...args) => {
                const provider = getCurrentProvider();
                if (!provider || provider.editorLanguage !== lang) return { suggestions: [] };
                const active = completionForProvider(provider);
                return active ? active.provideCompletionItems(...args) : { suggestions: [] };
            },
        });
        registeredLanguages.add(lang);
    };

    const formatSql = () => {
        if (!editor) return;
        const fmt = window.sqlFormatter;
        if (!fmt) {
            notify('SQL 格式化库未加载', 'warning');
            return;
        }
        if (typeof fmt.format !== 'function') {
            notify('sqlFormatter 对象异常', 'error');
            return;
        }
        const selection = editor.getSelection();
        const hasSelection = selection && !selection.isEmpty();
        const sql = hasSelection
            ? editor.getModel().getValueInRange(selection)
            : editor.getValue();
        if (!sql.trim()) return;
        const language = getCurrentSource()?.db_type === 'postgresql' ? 'postgresql' : 'mysql';
        try {
            const formatted = fmt.format(sql, { language });
            if (hasSelection) {
                editor.executeEdits('format', [{ range: selection, text: formatted }]);
            } else {
                const fullRange = editor.getModel().getFullModelRange();
                editor.executeEdits('format', [{ range: fullRange, text: formatted }]);
            }
            notify('格式化完成', 'success');
        } catch (e) {
            notify('格式化失败: ' + e.message, 'error');
        }
    };

    const getCurrentSqlStatement = () => {
        if (!editor) return '';
        const model = editor.getModel();
        const text = model.getValue();
        if (getCurrentSource()?.db_type === 'redis') {
            const line = model.getLineContent(editor.getPosition().lineNumber).trim();
            if (line && !line.startsWith('#')) return line;
            const commands = text
                .split(/\r?\n/)
                .map(item => item.trim())
                .filter(item => item && !item.startsWith('#'));
            return commands[0] || '';
        }
        const offset = model.getOffsetAt(editor.getPosition());
        const statements = splitSqlStatementsWithOffsets(text);
        const current = statements.find(stmt => offset >= stmt.start && offset <= stmt.end);
        return (current || statements[0])?.text || '';
    };

    /** 有选区时返回选中文本，否则返回光标所在语句。 */
    const getSelectedOrCurrentSql = () => {
        if (!editor) return '';
        const selection = editor.getSelection();
        if (selection && !selection.isEmpty()) {
            return editor.getModel().getValueInRange(selection);
        }
        return getCurrentSqlStatement();
    };

    const isRelationSuggestContext = () => {
        if (!editor) return false;
        const model = editor.getModel();
        const position = editor.getPosition();
        if (!model || !position) return false;
        const line = model.getLineContent(position.lineNumber);
        const textBeforeCursor = line.substring(0, position.column - 1);
        return /(?:^|\s)(?:FROM|JOIN)\s+[`"]?[\w$]*$/i.test(textBeforeCursor);
    };

    const isSuggestDetailsVisible = () => {
        const details = document.querySelector('.suggest-details:not(.no-docs)');
        if (!details) return false;
        const style = window.getComputedStyle(details);
        return details.offsetParent !== null && style.display !== 'none' && style.visibility !== 'hidden';
    };

    const autoOpenSuggestDetails = () => {
        if (!editor || !isRelationSuggestContext()) return;
        const widget = document.querySelector('.suggest-widget.visible');
        if (!widget || isSuggestDetailsVisible()) return;
        try {
            editor.trigger('auto-open-suggest-details', 'toggleSuggestionDetails', {});
        } catch (e) {
            console.debug('Unable to open suggestion details', e);
        }
    };

    const scheduleSuggestDetails = () => {
        if (suggestDetailsTimer) clearTimeout(suggestDetailsTimer);
        suggestDetailsTimer = setTimeout(() => {
            autoOpenSuggestDetails();
            setTimeout(autoOpenSuggestDetails, 160);
        }, 80);
    };

    /** 加载 Monaco 并创建编辑器；onExecute 绑定 Ctrl/Cmd+Enter，onReady 在创建完成后调用。 */
    const mountEditor = ({ onExecute, onReady } = {}) => {
        require.config({ paths: { 'vs': 'vendor/monaco/vs' }});
        require(['vs/editor/editor.main'], () => {
            monaco.editor.defineTheme('dbdeck-dark', {
                base: 'vs-dark',
                inherit: true,
                rules: [],
                colors: {
                    'editor.background': '#101820',
                    'editor.foreground': '#d7dde5',
                    'editorLineNumber.foreground': '#66717f',
                    'editorCursor.foreground': '#5fb3ff',
                    'editor.selectionBackground': '#26465f',
                    'editor.lineHighlightBackground': '#172330',
                },
            });
            editor = monaco.editor.create(document.getElementById('monaco-editor'), {
                value: '',
                language: 'mysql',
                theme: 'dbdeck-dark',
                readOnly: isReadOnly.value,
                domReadOnly: isReadOnly.value,
                automaticLayout: true,
                minimap: { enabled: false },
                fontSize: 13,
                lineHeight: 20,
                scrollBeyondLastLine: false,
                tabSize: 4,
                renderLineHighlight: 'all',
                suggest: {
                    showInlineDetails: true,
                    showStatusBar: true,
                    preview: true,
                },
            });
            if (onExecute) {
                editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => onExecute());
            }
            editor.onDidChangeModelContent(() => {
                if (isApplyingScript) {
                    scheduleSuggestDetails();
                    return;
                }
                if (autoSaveTimer) clearTimeout(autoSaveTimer);
                const sourceId = getCurrentSource()?.id;
                const content = editor.getValue();
                autoSaveTimer = setTimeout(() => {
                    if (sourceId) dbService.saveScript(sourceId, content);
                }, 2000);
                scheduleSuggestDetails();
            });
            editor.onDidChangeCursorPosition(scheduleSuggestDetails);
            ensureCompletionRegistered();
            if (onReady) onReady(editor);
        });
    };

    return {
        getEditor,
        getValue,
        setValue,
        layout,
        applyEditorLanguage,
        loadSourceScript,
        saveCurrentSourceScript,
        ensureCompletionRegistered,
        formatSql,
        getCurrentSqlStatement,
        getSelectedOrCurrentSql,
        mountEditor,
    };
}
