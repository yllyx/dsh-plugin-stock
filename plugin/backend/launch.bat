@echo off
chcp 65001 >nul
title DSH Stock Backend

REM ============================================
REM  DSH 股票插件后端启动脚本
REM ============================================

echo ========================================
echo   DSH 股票插件 - Python 后端服务
echo ========================================
echo.

cd /d "%~dp0"

REM 检查 Python
where python >nul 2>&1
if errorlevel 1 (
    echo [错误] 未检测到 Python，请先安装 Python 3.10+
    echo 下载地址: https://www.python.org/downloads/
    pause
    exit /b 1
)

echo [信息] 检查依赖...
python -c "import fastapi" 2>nul
if errorlevel 1 (
    echo [信息] 安装依赖中...
    python -m pip install -r requirements.txt
    if errorlevel 1 (
        echo [错误] 依赖安装失败
        pause
        exit /b 1
    )
)

echo [信息] 启动服务...
echo 访问 http://127.0.0.1:8765/docs 查看 API 文档
echo.

python -m uvicorn main:app --host 127.0.0.1 --port 8765 --reload

pause
