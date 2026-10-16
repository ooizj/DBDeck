@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if not exist "venv\Scripts\python.exe" (
    echo [INFO] 未找到 venv，正在创建虚拟环境...
    where py >nul 2>nul
    if errorlevel 1 (
        python -m venv venv || goto :error
    ) else (
        py -3 -m venv venv || goto :error
    )
)

echo [INFO] 安装/更新打包依赖...
venv\Scripts\python.exe -m pip install -r requirements-build.txt || goto :error

echo [INFO] 开始打包 DBDeck...
venv\Scripts\python.exe scripts\package_app.py || goto :error

echo.
echo [INFO] 打包完成：dist\DBDeck.exe
pause
exit /b 0

:error
echo.
echo [ERROR] 打包失败，请查看上方错误信息。
pause
exit /b 1
