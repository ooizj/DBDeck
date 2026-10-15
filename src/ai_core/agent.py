"""
通用 LLM Agent —— ReAct 循环，工具集和 system prompt 都从 SourceProvider 拿。

设计要点：
- 不再 isinstance 检查具体数据源类型；任何 provider 都走同一个循环
- 工具是否"产生查询"看返回结果里有没有 query / executed_sql 字段（约定式），不再硬编码白名单
- DDL 不再短路：即使工具返回 kind=="ddl" 且 success，也继续循环让 LLM 执行后续操作（如建表后插数据）
- 切换数据源时由调用方决定是否 reset；本类只负责单一会话内的循环
"""
from __future__ import annotations

import json
import logging
import re
import time
import uuid
from typing import Any, AsyncGenerator, Dict, List, Optional, Tuple

from openai import AsyncOpenAI

from src.ai_core.tools.registry import ToolContext, serialize_result
from src.ai_core.mcp_client import manager as mcp_manager, TOOL_PREFIX as MCP_TOOL_PREFIX
from src.ai_core.tool_policy import needs_confirmation
from src.common.config import config
from src.common.storage import storage
from src.sources.base import DataSourceClient, SourceProvider

logger = logging.getLogger(__name__)

_MAX_HISTORY_MESSAGES = 30
_MAX_ITERATIONS = 10
_CONFIRM_PREFIX = "__confirm__:"
_SQL_FENCE_RE = re.compile(r"```(?:sql)?\s*(.*?)```", re.I | re.S)
_SQL_START_RE = re.compile(
    r"^\s*(SELECT|SHOW|DESC|DESCRIBE|EXPLAIN|WITH|PRAGMA|INSERT|UPDATE|DELETE|"
    r"REPLACE|MERGE|CREATE|ALTER|DROP|TRUNCATE|RENAME)\b",
    re.I,
)

_CODE_EDITING_PROMPT_PATCH = """

# 核心指令：代码编辑与工作区操作规范

当前项目工作区已激活。你拥有通过 `fs_*` 前缀工具读取、搜索、编辑和创建文件的权限。请严格遵守以下操作硬约束。

---

## 🚨 路径参数硬要求（最高优先级）

* **绝对路径限制**：所有工具的 `path` 参数**必须是绝对路径**，且必须以给定的“工作区路径”开头。
* **严禁相对路径**：**绝对禁止**使用 `.`, `./`, `~` 或任何项目相对路径，否则 MCP 沙箱将直接拒绝执行。
* **路径分隔符规范**：统一使用**正斜杠 `/`** 作为路径分隔符（例如：`C:/foo/bar/src/main.py`）。严禁使用未转义的单反斜杠 `\\`。

---

## 🛠️ 工具操作规范

### 1. 文件检索与查找
* **深层递归搜索（Glob 规则）**：使用 `fs_search_files` 查找文件时，`pattern` 参数**必须**使用双星号 `**/*` 格式以支持递归子目录搜索（例如：`**/*文件名*` 或 `**/*HelloResource*`）。
    > *注意：普通的 `*文件名*` 只能匹配当前层级，无法触达深层目录。*
* **高效检索**：优先使用 `fs_search_files` 精确查找，禁止盲目使用 `fs_list_directory` 穷举目录。同一目录下严禁重复执行 `fs_list_directory`。
* **内容搜索替代方案**：`fs_search_files` 仅支持按文件名搜索。若需查找特定代码内容（如 "implements XXX"），请根据命名预判并用 `fs_read_file` 定向读取，**严禁**逐个遍历读取所有文件。
* **未找到实现类的止损逻辑**：若检索 2-3 次仍未找到实现类，判定该项目仅包含接口定义。此时应**直接在接口文件中新增方法定义**，并告知用户实现类可能位于其他独立项目中。

### 2. 文件修改与写入
* **先读后改（严禁盲猜）**：在执行 `fs_edit_file` 或 `fs_write_file` 之前，**必须**先调用 `fs_read_file` 读取当前文件内容。根据实际内容进行精确替换，**严禁**基于猜测整盘覆写。
* **无需前置确认**：对于写入、修改、删除、移动（`fs_write_file`, `fs_edit_file`, `fs_move_file` 等）等敏感操作，前端系统会自动拦截并弹出用户确认窗。你只需**直接发起工具调用**，无需在对话中反复询问用户是否确认。

### 3. 结果汇报
* **精简汇报**：操作完成后，仅需用 1-2 句话简要说明修改了哪些文件及核心变更。**严禁在对话中复述整段代码**。

---

## 🔍 工具结果解读指南

* **成功判定**：工具返回 `{"success": true, "output": "..."}` 即代表执行成功。`output` 内即为 MCP 服务返回的真实文本（如目录列表、文件内容等），请直接使用。
* **空输出处理**：若 `success` 均为 `true` 但 `output` 为空，说明目录无文件或文件无内容，**严禁将其主观臆断为“工具失败”**。
* **失败判定**：仅当工具返回 `{"success": false, "error": "..."}` 时才视为失败。此时请直接将 `error` 信息提取并反馈给用户。

"""


def _result_has_query(result: Dict[str, Any]) -> Optional[str]:
    return result.get("query") or result.get("executed_sql") or result.get("sql")


def _append_unique(values: List[str], value: Optional[str]) -> None:
    if value and value not in values:
        values.append(value)


def _contains_sql_answer(text: str) -> bool:
    candidates = [m.group(1).strip() for m in _SQL_FENCE_RE.finditer(text or "")]
    stripped = (text or "").strip()
    if _SQL_START_RE.match(stripped):
        candidates.append(stripped)
    return any(_SQL_START_RE.match(candidate) for candidate in candidates)


def _detect_repetition(text: str, max_repeats: int = 8, min_length: int = 10) -> bool:
    """
    检测文本末尾是否在连续重复同一个子字符串（去空格/换行后，长度 >= min_length，重复次数 >= max_repeats）。
    能极其高效地在 Streaming 过程中发现并拦截大模型的“无限复读机循环”。
    """
    import re
    normalized = re.sub(r'\s+', '', text)
    n = len(normalized)
    if n < min_length * max_repeats:
        return False
    for l in range(min_length, min(150, n // max_repeats + 1)):
        segment = normalized[-l:]
        if normalized[-(l * max_repeats):] == segment * max_repeats:
            return True
    return False


def _detect_reasoning_loop(
    text: str, probe: int = 60, threshold: int = 4, scan: int = 2400
) -> bool:
    """
    专给 reasoning_content（思考过程）用的循环检测。

    _detect_repetition 依赖“精确猜中重复周期 p”，但推理死循环的周期长度是任意的
    （实测可达 400+ 字符），且 p 超过 150 上限就检测不到。

    这里改用更鲁棒的判据：取末尾 probe 个字符，看它在最近 scan 窗口里出现了几次；
    只要 >= threshold 次就判定为循环。因为周期性文本里“任意一段尾部”都会每周期复现一次，
    所以无需知道周期长度即可命中。threshold=4 ≈ 出现 4 个周期就拦下，足够早又几乎不误杀。
    """
    import re
    normalized = re.sub(r'\s+', '', text)
    n = len(normalized)
    if n < probe * threshold:
        return False
    region = normalized[-scan:] if n >= scan else normalized
    return region.count(normalized[-probe:]) >= threshold


class Agent:
    def __init__(self) -> None:
        self._client: Optional[AsyncOpenAI] = None
        self._client_key: tuple = ()
        self.history: List[Dict[str, Any]] = []
        self.session: Dict[str, Any] = {}
        # 记录当前历史所对应的 provider id；切换数据源时由调用方根据这个判断是否需要 reset
        self.bound_provider_id: Optional[str] = None
        # 待用户确认的批次：{pending_id, assistant_msg, tool_calls}
        self.pending: Optional[Dict[str, Any]] = None

    @property
    def client(self) -> AsyncOpenAI:
        # 同时跟踪 api_key 与 base_url；config.reload() 改了任一个都要重建
        key = (config.llm_api_key, config.llm_api_base)
        if not self._client or key != self._client_key:
            if config.llm_api_key:
                self._client = AsyncOpenAI(
                    api_key=config.llm_api_key,
                    base_url=config.llm_api_base,
                )
                self._client_key = key
                logger.info(f"[Agent] LLM client refreshed: base={config.llm_api_base}")
        return self._client

    def reset(self) -> None:
        self.history = []
        self.session = {}
        self.bound_provider_id = None
        self.pending = None

    def _render_session_context(self, provider: SourceProvider) -> str:
        lines: List[str] = [
            f"当前连接的数据源类型：{provider.display_name} ({provider.id})"
        ]
        last_query = self.session.get("last_query")
        last_result = self.session.get("last_result")
        if last_query:
            lines.append(f"上一次执行的查询：{last_query}")
        if last_result:
            cols = last_result.get("columns") or []
            row_count = last_result.get("row_count")
            lines.append(
                f"上一次结果：{row_count} 行，列 = {cols[:8]}{' ...' if len(cols) > 8 else ''}"
            )
        return "\n".join(lines)

    def _trim_history(self) -> None:
        if len(self.history) <= _MAX_HISTORY_MESSAGES:
            return
        keep_tail = _MAX_HISTORY_MESSAGES - 1
        self.history = self.history[:1] + self.history[-keep_tail:]

    def _capture_tool_result(
        self, tool_name: str, result: Dict[str, Any]
    ) -> None:
        if not result.get("success"):
            return
        q = _result_has_query(result)
        if q:
            self.session["last_query"] = q
        if "data" in result:
            self.session["last_result"] = {
                "columns": result.get("columns", []),
                "column_metadata": result.get("column_metadata", {}),
                "data": result.get("data", []),
                "row_count": result.get("row_count", 0),
            }

    async def _resolve_workspace_mcp(
        self, workspace_id: Optional[int]
    ) -> tuple[Optional[Any], List[Dict[str, Any]], Optional[str], Optional[str]]:
        """根据 workspace_id 取 MCP client、工具列表、workspace 路径、错误信息。"""
        if workspace_id is None:
            return None, [], None, None
        ws = storage.get_workspace(workspace_id)
        if not ws:
            return None, [], None, f"workspace_id={workspace_id} 不存在"
        try:
            client = await mcp_manager.get(workspace_id, ws["path"])
            tools = await client.list_tools()
            return client, tools, ws["path"], None
        except Exception as e:
            err = f"{type(e).__name__}: {e}"
            logger.error(f"[Agent] MCP unavailable for workspace {workspace_id}: {err}", exc_info=True)
            return None, [], ws["path"], err

    async def _invoke_tool(
        self,
        name: str,
        args: Dict[str, Any],
        ctx: ToolContext,
        tools_registry,
        mcp_client: Optional[Any],
    ) -> Dict[str, Any]:
        if name.startswith(MCP_TOOL_PREFIX):
            if mcp_client is None:
                return {"success": False, "error": "未选择项目工作区，无法使用文件工具"}
            return await mcp_client.call_tool(name, args)
        return await tools_registry.invoke(name, args, ctx)

    async def chat(
        self,
        user_input: str,
        *,
        provider: SourceProvider,
        db: Optional[DataSourceClient] = None,
        workspace_id: Optional[int] = None,
        source_id: Optional[int] = None,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        if not config.llm_api_key or config.llm_api_key == "your_api_key_here":
            yield {
                "type": "error",
                "message": "未配置 LLM API Key。请点击右上角的“设置”按钮进行配置。",
            }
            return

        # 切换 provider 时自动 reset，避免历史 system prompt 与当前数据源对不上
        if (
            self.bound_provider_id is not None
            and self.bound_provider_id != provider.id
        ):
            logger.info(
                f"[Agent] provider switched {self.bound_provider_id} → {provider.id}, reset history"
            )
            self.reset()
        self.bound_provider_id = provider.id

        tools_registry = provider.tools()
        mcp_client, mcp_tools, workspace_path, mcp_error = await self._resolve_workspace_mcp(workspace_id)
        if workspace_path:
            self.session["workspace_path"] = workspace_path
        ctx = ToolContext(
            db=db,
            session=self.session,
            extras={"source_id": source_id, "provider_id": provider.id},
        )

        # 用户选了 workspace 但 MCP 起不来 —— 必须告诉用户，否则 LLM 会在没有 fs_ 工具的情况下编造借口
        if workspace_id is not None and mcp_client is None and mcp_error:
            yield {
                "type": "error",
                "message": (
                    f"项目工作区 MCP 服务启动失败：{mcp_error}\n"
                    f"路径：{workspace_path or '(unknown)'}\n"
                    f"请确认：(1) Node.js 18+ 已安装且 npx 在 PATH 中；"
                    f"(2) 目录存在且可访问；(3) 首次启动需联网拉取 @modelcontextprotocol/server-filesystem。"
                ),
            }
            return

        system_prompt = provider.system_prompt(session_ctx="")
        if mcp_client is not None:
            system_prompt = system_prompt + _CODE_EDITING_PROMPT_PATCH + (
                f"\n当前工作区路径：{workspace_path}\n"
            )
        system_msg = {"role": "system", "content": system_prompt}
        if not self.history:
            self.history.append(system_msg)
        else:
            self.history[0] = system_msg

        # 合并工具：provider 自带 + workspace MCP
        combined_tools = list(tools_registry.openai_tools()) + list(mcp_tools)

        turn_query: Optional[str] = None
        turn_queries: List[str] = []
        turn_result: Optional[Dict[str, Any]] = None
        resume_tool_calls: Optional[List[Dict[str, Any]]] = None

        # ---- 用户的确认 / 拒绝回复 ----
        if user_input.startswith(_CONFIRM_PREFIX):
            try:
                _, pid, decision = user_input.split(":", 2)
            except ValueError:
                yield {"type": "error", "message": "确认指令格式错误"}
                return
            if not self.pending or self.pending.get("pending_id") != pid:
                yield {"type": "error", "message": "没有匹配的待确认操作（可能已过期）"}
                return
            pending = self.pending
            self.pending = None
            self.history.append(pending["assistant_msg"])
            if decision == "approve":
                resume_tool_calls = pending["tool_calls"]
            else:
                for call in pending["tool_calls"]:
                    self.history.append({
                        "role": "tool",
                        "tool_call_id": call["id"],
                        "content": json.dumps(
                            {"success": False, "error": "用户已拒绝该操作"},
                            ensure_ascii=False,
                        ),
                    })
                    yield {
                        "type": "tool_end",
                        "tool": call["function"]["name"],
                        "result": {"success": False, "error": "用户已拒绝"},
                    }
        else:
            self.pending = None
            session_ctx_str = self._render_session_context(provider)
            user_content = (
                f"=== 当前会话数据库上下文 ===\n"
                f"{session_ctx_str}\n"
                f"===========================\n\n"
                f"用户请求：{user_input}"
            )
            self.history.append({"role": "user", "content": user_content})

        try:
            tool_call_history = []
            force_final_answer = False  # 检测到工具重复调用后置 True，下一轮强制收尾（禁止再调用工具）
            sql_protocol_repair_attempted = False
            for iteration in range(_MAX_ITERATIONS):
                logger.info(f"[Agent] iteration {iteration + 1}/{_MAX_ITERATIONS}")

                if resume_tool_calls is not None:
                    # 跳过 LLM 调用，直接接续之前缓存的 tool_calls
                    tool_calls = resume_tool_calls
                    resume_tool_calls = None
                else:
                    # 倒数第 2 次迭代善后提示注入 (修复 4)
                    if iteration == _MAX_ITERATIONS - 2:
                        warning_text = "⚠️ 你只剩最后 2 次工具调用机会。请立即执行修改或给出最终答案，不要再进行探索性操作。"
                        if not (self.history and self.history[-1].get("role") == "system" and self.history[-1].get("content") == warning_text):
                            logger.warning("[Agent] Near max iterations! Injecting wrap-up warning.")
                            self.history.append({
                                "role": "system",
                                "content": warning_text
                            })

                    stream = await self.client.chat.completions.create(
                        model=config.llm_model,
                        messages=self.history,
                        tools=combined_tools,
                        tool_choice=("none" if force_final_answer else "auto"),
                        temperature=config.llm_temperature,
                        max_tokens=config.llm_max_tokens,
                        stream=True,
                    )

                    full_content = ""
                    full_reasoning = ""
                    finish_reason: Optional[str] = None
                    tool_calls_dict: Dict[int, Dict[str, Any]] = {}

                    async for chunk in stream:
                        if not chunk.choices:
                            continue
                        choice = chunk.choices[0]
                        delta = choice.delta
                        if choice.finish_reason:
                            finish_reason = choice.finish_reason
                        # DeepSeek-R1 / Qwen-Reasoning 等 thinking 模型必须把 reasoning_content 回传
                        reasoning_piece = getattr(delta, "reasoning_content", None)
                        if reasoning_piece:
                            full_reasoning += reasoning_piece
                            # 推理模型的“思考过程”同样会陷入重复死循环（这是无限输出的真实根因）。
                            # 此时正文通常为空，中断后由下文按“无 tool_calls”分支给出可见提示。
                            if _detect_reasoning_loop(full_reasoning):
                                logger.warning(
                                    f"[Agent] Reasoning loop detected! Cutting off stream. End reasoning snippet: {full_reasoning[-100:]!r}"
                                )
                                warning_msg = "\n\n[模型在思考过程中陷入重复循环，已自动中断以避免消耗过多 Token，请重试或简化问题。]"
                                full_content += warning_msg
                                yield {"type": "delta", "content": warning_msg}
                                break
                        if delta.content:
                            full_content += delta.content
                            yield {"type": "delta", "content": delta.content}
                            if _detect_repetition(full_content):
                                logger.warning(
                                    f"[Agent] Repetition loop detected! Cutting off stream. End content snippet: {full_content[-100:]!r}"
                                )
                                warning_msg = "\n\n[检测到模型生成内容出现异常重复循环，已自动拦截中断，避免消耗过多 Token]"
                                full_content += warning_msg
                                yield {"type": "delta", "content": warning_msg}
                                break
                        if delta.tool_calls:
                            for tc in delta.tool_calls:
                                slot = tool_calls_dict.setdefault(
                                    tc.index,
                                    {
                                        "id": tc.id,
                                        "type": "function",
                                        "function": {"name": "", "arguments": ""},
                                    },
                                )
                                if tc.id and not slot["id"]:
                                    slot["id"] = tc.id
                                if tc.function:
                                    if tc.function.name:
                                        slot["function"]["name"] = tc.function.name
                                    if tc.function.arguments:
                                        slot["function"]["arguments"] += tc.function.arguments

                    tool_calls = [v for _, v in sorted(tool_calls_dict.items())]

                    # 触达 max_tokens 上限被截断：给出可见提示，避免悄悄截断半个答案
                    if finish_reason == "length":
                        logger.warning(
                            f"[Agent] Output truncated by max_tokens={config.llm_max_tokens}."
                        )
                        length_note = "\n\n[已达到最大输出长度上限并被截断。可在「设置」中调高 Max Tokens，或简化问题后重试。]"
                        full_content += length_note
                        yield {"type": "delta", "content": length_note}

                    assistant_msg: Dict[str, Any] = {
                        "role": "assistant",
                        "content": full_content,
                    }
                    if full_reasoning:
                        assistant_msg["reasoning_content"] = full_reasoning
                    if tool_calls:
                        assistant_msg["tool_calls"] = tool_calls

                    if not tool_calls:
                        if (
                            not sql_protocol_repair_attempted
                            and provider.capabilities.query_language == "sql"
                            and tools_registry.get("execute_sql") is not None
                            and _contains_sql_answer(full_content)
                        ):
                            sql_protocol_repair_attempted = True
                            self.history.append(assistant_msg)
                            self.history.append(
                                {
                                    "role": "system",
                                    "content": (
                                        "上一条助手回复包含 SQL，但没有调用数据库工具。"
                                        "在这个 GUI 中，查询结果只有通过 execute_sql 工具才会渲染。"
                                        "请继续同一个用户请求：如果需要查询数据，请调用 execute_sql；"
                                        "如果用户只是要求 SQL 文本，请直接给出简短最终回答，且不要声称已查询完成。"
                                    ),
                                }
                            )
                            continue

                        self.history.append(assistant_msg)
                        yield {
                            "type": "final",
                            "answer": full_content,
                            "sql": turn_query,
                            "queries": turn_queries,
                            "data": turn_result,
                        }
                        self._trim_history()
                        return

                    # ---- 确认门控 ----
                    preview = []
                    requires_confirmation = False
                    for c in tool_calls:
                        try:
                            args = json.loads(c["function"]["arguments"] or "{}")
                        except json.JSONDecodeError:
                            args = {}
                        confirm = needs_confirmation(c["function"]["name"], args)
                        requires_confirmation = requires_confirmation or confirm
                        preview.append({
                            "tool": c["function"]["name"],
                            "args": args,
                            "needs_confirm": confirm,
                        })

                    if requires_confirmation:
                        pending_id = uuid.uuid4().hex
                        self.pending = {
                            "pending_id": pending_id,
                            "assistant_msg": assistant_msg,
                            "tool_calls": tool_calls,
                        }
                        yield {
                            "type": "confirm_required",
                            "pending_id": pending_id,
                            "calls": preview,
                        }
                        return

                    self.history.append(assistant_msg)

                # ---- 执行 tool_calls ----
                has_ddl_in_iteration = False
                for call in tool_calls:
                    name = call["function"]["name"]
                    raw_args = call["function"]["arguments"] or "{}"
                    try:
                        args = json.loads(raw_args)
                    except json.JSONDecodeError:
                        args = {}

                    # 追踪工具调用历史 (修复 2)
                    stable_args = json.dumps(args, sort_keys=True)
                    tool_call_history.append((name, stable_args))

                    yield {"type": "tool_start", "tool": name, "args": args}
                    result = await self._invoke_tool(name, args, ctx, tools_registry, mcp_client)
                    if isinstance(result, dict):
                        result.setdefault("source_id", source_id)
                        result.setdefault("provider_id", provider.id)
                        executed_query = (
                            result.get("executed_query")
                            or result.get("executed_sql")
                            or result.get("query")
                            or result.get("sql")
                        )
                        if executed_query:
                            result["executed_query"] = executed_query

                    if result.get("success"):
                        q = _result_has_query(result)
                        if q:
                            turn_query = q
                            _append_unique(turn_queries, q)
                            if result.get("kind") == "ddl":
                                has_ddl_in_iteration = True
                        if "data" in result:
                            turn_result = {
                                "columns": result.get("columns", []),
                                "column_metadata": result.get("column_metadata", {}),
                                "data": result.get("data", []),
                                "row_count": result.get("row_count", 0),
                                "executed_sql": result.get("executed_sql") or q,
                                "executed_queries": turn_queries,
                                "success": True,
                            }
                    self._capture_tool_result(name, result)
                    yield {"type": "tool_end", "tool": name, "result": result}
                    self.history.append(
                        {
                            "role": "tool",
                            "tool_call_id": call["id"],
                            "content": serialize_result(result),
                        }
                    )

                # 重复调用检测：硬性收尾。不再只发"软警告"——模型可以无视软警告继续打转。
                # 这里直接锁定下一轮 tool_choice="none"，强制模型基于已有信息给出最终回答。
                from collections import Counter
                if len(tool_call_history) >= 6 and not force_final_answer:
                    recent = tool_call_history[-6:]
                    counts = Counter(recent)
                    if any(v >= 3 for v in counts.values()):
                        logger.warning("[Agent] Tool repetition detected! Forcing final answer (tool_choice=none).")
                        force_final_answer = True
                        self.history.append({
                            "role": "system",
                            "content": "⚠️ 检测到你重复调用了同一个工具但没有任何进展。请立即停止调用工具，基于已有信息给出最终回答；若遇到困难，如实向用户说明。"
                        })

                # DDL 执行后不再短路终止，让 LLM 继续下一轮迭代
                # 以便执行用户请求中的后续操作（如建表后插入数据）
                if has_ddl_in_iteration:
                    logger.info("[Agent] DDL executed in this iteration, continuing loop for possible follow-up")

            yield {
                "type": "error",
                "message": f"达到最大迭代次数 {_MAX_ITERATIONS}，可能陷入循环",
            }
        except Exception as e:
            logger.error(f"Agent error: {e}", exc_info=True)
            yield {"type": "error", "message": f"处理请求时出错: {e}"}


class AgentManager:
    """Keeps conversational Agent state scoped to a UI session."""

    def __init__(self, ttl_seconds: int = 7200, max_sessions: int = 64) -> None:
        self.ttl_seconds = ttl_seconds
        self.max_sessions = max_sessions
        self._agents: Dict[str, Tuple[Agent, float]] = {}

    @staticmethod
    def normalize_session_id(session_id: Optional[str]) -> str:
        normalized = (session_id or "default").strip()
        return normalized or "default"

    def get(self, session_id: Optional[str]) -> Agent:
        key = self.normalize_session_id(session_id)
        self.cleanup()
        if key not in self._agents:
            self._agents[key] = (Agent(), time.time())
        agent, _ = self._agents[key]
        self._agents[key] = (agent, time.time())
        self._enforce_limit()
        return agent

    def reset(self, session_id: Optional[str]) -> None:
        key = self.normalize_session_id(session_id)
        item = self._agents.get(key)
        if item is None:
            return
        agent, _ = item
        agent.reset()
        self._agents[key] = (agent, time.time())

    def drop(self, session_id: Optional[str]) -> None:
        key = self.normalize_session_id(session_id)
        self._agents.pop(key, None)

    def cleanup(self) -> None:
        now = time.time()
        expired = [
            key for key, (_, last_used) in self._agents.items()
            if now - last_used > self.ttl_seconds
        ]
        for key in expired:
            self._agents.pop(key, None)

    def _enforce_limit(self) -> None:
        overflow = len(self._agents) - self.max_sessions
        if overflow <= 0:
            return
        oldest = sorted(self._agents.items(), key=lambda item: item[1][1])[:overflow]
        for key, _ in oldest:
            self._agents.pop(key, None)
