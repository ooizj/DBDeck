"""
MCP 客户端管理器 —— 按 workspace 启动并缓存 filesystem MCP 子进程。

设计：
- 每个 workspace 对应一个常驻 stdio 子进程（npx @modelcontextprotocol/server-filesystem <path>）
- 首次访问时惰性启动，进程的 stdio_client + ClientSession 通过 AsyncExitStack 持有
- 工具名加前缀 "fs_" 后注入 Agent 的工具列表，避免与本地 @tool 冲突
- 调用前会把前缀剥掉再转给 MCP

注意：
- Windows 上 npx 是 .cmd 文件，需要走 cmd /c 启动
- 启动失败要给清晰的报错（提示装 Node / 检查路径）
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys
from contextlib import AsyncExitStack
from pathlib import Path
from typing import Any, Dict, List, Optional

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

logger = logging.getLogger(__name__)

TOOL_PREFIX = "fs_"


def _build_server_params(workspace_path: str) -> StdioServerParameters:
    """构造启动 filesystem MCP 服务的参数。"""
    abs_path = str(Path(workspace_path).resolve())
    if sys.platform == "win32":
        # npx 是 .cmd，必须走 cmd /c 才能被 create_subprocess_exec 找到
        return StdioServerParameters(
            command="cmd",
            args=["/c", "npx", "-y", "@modelcontextprotocol/server-filesystem", abs_path],
            env=dict(os.environ),
        )
    return StdioServerParameters(
        command="npx",
        args=["-y", "@modelcontextprotocol/server-filesystem", abs_path],
        env=dict(os.environ),
    )


class WorkspaceClient:
    """一个 workspace 对应一个常驻 MCP 子进程 + ClientSession。

    关键：stdio_client / ClientSession 的上下文必须由一个**长生命周期的 task** 持有，
    否则首次请求 task 结束时，anyio 会清理那个 task 下的所有子 task（包括 stdio 读写），
    导致后续请求拿到 ClosedResourceError。
    """

    def __init__(self, workspace_id: int, workspace_path: str) -> None:
        self.workspace_id = workspace_id
        self.workspace_path = workspace_path
        self._session: Optional[ClientSession] = None
        self._runner_task: Optional[asyncio.Task] = None
        self._ready = asyncio.Event()
        self._shutdown = asyncio.Event()
        self._startup_error: Optional[BaseException] = None
        self._tools_cache: Optional[List[Dict[str, Any]]] = None
        self._lock = asyncio.Lock()

    async def _runner(self) -> None:
        """后台 task：持有 stdio + session，直到 close() 触发 _shutdown。"""
        try:
            params = _build_server_params(self.workspace_path)
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    self._session = session
                    logger.info(
                        f"[MCP] runner ready for workspace {self.workspace_id} "
                        f"at {self.workspace_path}"
                    )
                    self._ready.set()
                    # 阻塞直到 close() 触发
                    await self._shutdown.wait()
        except FileNotFoundError as e:
            self._startup_error = RuntimeError(
                "无法启动 MCP filesystem 服务：找不到 npx。请安装 Node.js 18+ 后重试。"
            )
            logger.error(f"[MCP] runner failed (FileNotFoundError): {e}")
        except BaseException as e:
            self._startup_error = e
            logger.error(f"[MCP] runner died: {type(e).__name__}: {e}", exc_info=True)
        finally:
            self._session = None
            # 即使失败也要 set，避免 start() 永远等
            self._ready.set()
            logger.info(f"[MCP] runner exited for workspace {self.workspace_id}")

    async def start(self) -> None:
        async with self._lock:
            # 已经有活跃 session 直接返回
            if (
                self._runner_task is not None
                and not self._runner_task.done()
                and self._session is not None
            ):
                return
            # 旧 runner 已死（例如子进程崩了），清理后重启
            if self._runner_task is not None and self._runner_task.done():
                self._runner_task = None
                self._session = None
                self._tools_cache = None
            self._ready = asyncio.Event()
            self._shutdown = asyncio.Event()
            self._startup_error = None
            self._runner_task = asyncio.create_task(
                self._runner(), name=f"mcp-runner-ws{self.workspace_id}"
            )
            try:
                await asyncio.wait_for(self._ready.wait(), timeout=30)
            except asyncio.TimeoutError as e:
                self._shutdown.set()
                raise RuntimeError("MCP filesystem 服务启动超时（30s）") from e
            if self._startup_error is not None:
                raise self._startup_error
            if self._session is None:
                raise RuntimeError("MCP session 未就绪（runner 已退出但无具体错误）")

    async def close(self) -> None:
        async with self._lock:
            self._shutdown.set()
            task = self._runner_task
            self._runner_task = None
            self._session = None
            self._tools_cache = None
        if task is not None:
            try:
                await asyncio.wait_for(task, timeout=5)
            except asyncio.TimeoutError:
                task.cancel()
        logger.info(f"[MCP] closed workspace {self.workspace_id}")

    async def list_tools(self) -> List[Dict[str, Any]]:
        """返回带 fs_ 前缀的工具描述（OpenAI function schema 形式）。"""
        await self.start()
        if self._tools_cache is not None:
            return self._tools_cache
        assert self._session is not None
        resp = await self._session.list_tools()
        tools: List[Dict[str, Any]] = []
        for t in resp.tools:
            schema = t.inputSchema or {"type": "object", "properties": {}}
            tools.append({
                "type": "function",
                "function": {
                    "name": TOOL_PREFIX + t.name,
                    "description": t.description or "",
                    "parameters": schema,
                },
            })
        self._tools_cache = tools
        return tools

    async def call_tool(self, prefixed_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        if not prefixed_name.startswith(TOOL_PREFIX):
            return {"success": False, "error": f"非 MCP 工具：{prefixed_name}"}
        raw_name = prefixed_name[len(TOOL_PREFIX):]
        await self.start()
        logger.info(f"[MCP] -> {raw_name} args={arguments}")

        async def _do() -> Any:
            assert self._session is not None
            return await self._session.call_tool(raw_name, arguments=arguments)

        try:
            result = await _do()
        except Exception as e:
            # ClosedResourceError 等：runner 已死，关闭后重启一次再试
            err_name = type(e).__name__
            if "Closed" in err_name or err_name in ("BrokenResourceError", "EndOfStream"):
                logger.warning(f"[MCP] stream closed ({err_name}); restarting runner and retrying once")
                await self.close()
                try:
                    await self.start()
                    result = await _do()
                except Exception as e2:
                    logger.error(f"[MCP] retry also failed: {e2}", exc_info=True)
                    return {"success": False, "error": f"{type(e2).__name__}: {e2}"}
            else:
                logger.error(f"[MCP] call_tool {raw_name} raised: {e}", exc_info=True)
                return {"success": False, "error": str(e)}

        # 把 MCP 的 content 列表压平成纯文本，方便给 LLM 看
        text_parts: List[str] = []
        for c in result.content:
            text = getattr(c, "text", None)
            if text:
                text_parts.append(text)
        payload = "\n".join(text_parts) if text_parts else ""

        preview = payload[:200].replace("\n", " | ")
        logger.info(f"[MCP] <- {raw_name} isError={result.isError} len={len(payload)} preview={preview!r}")

        if result.isError:
            return {"success": False, "error": payload or "MCP tool error"}
        return {"success": True, "output": payload}


class WorkspaceMCPManager:
    """按 workspace_id 缓存 WorkspaceClient。"""

    def __init__(self) -> None:
        self._clients: Dict[int, WorkspaceClient] = {}
        self._lock = asyncio.Lock()

    async def get(self, workspace_id: int, workspace_path: str) -> WorkspaceClient:
        async with self._lock:
            client = self._clients.get(workspace_id)
            if client is not None and client.workspace_path != workspace_path:
                # 路径变了，先关旧的
                await client.close()
                client = None
            if client is None:
                client = WorkspaceClient(workspace_id, workspace_path)
                self._clients[workspace_id] = client
        await client.start()
        return client

    async def drop(self, workspace_id: int) -> None:
        async with self._lock:
            client = self._clients.pop(workspace_id, None)
        if client is not None:
            await client.close()

    async def close_all(self) -> None:
        async with self._lock:
            clients = list(self._clients.values())
            self._clients.clear()
        for c in clients:
            try:
                await c.close()
            except Exception as e:
                logger.warning(f"[MCP] close error: {e}")


manager = WorkspaceMCPManager()
