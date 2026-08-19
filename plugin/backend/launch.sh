#!/bin/bash
# DSH 股票插件后端启动脚本 (Linux/Mac)

set -e

cd "$(dirname "$0")"

echo "========================================"
echo "  DSH 股票插件 - Python 后端服务"
echo "========================================"

# 检查 Python
if ! command -v python3 &> /dev/null; then
    echo "[错误] 未检测到 python3，请先安装 Python 3.10+"
    exit 1
fi

# 检查依赖
echo "[信息] 检查依赖..."
if ! python3 -c "import fastapi" 2>/dev/null; then
    echo "[信息] 安装依赖中..."
    python3 -m pip install -r requirements.txt
fi

echo "[信息] 启动服务..."
echo "访问 http://127.0.0.1:8765/docs 查看 API 文档"
echo ""

python3 -m uvicorn main:app --host 127.0.0.1 --port 8765 --reload
