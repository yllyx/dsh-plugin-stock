"""
后端服务冒烟测试
不依赖通达信连接，只测试 API 框架是否正常
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))

from fastapi.testclient import TestClient
from main import app

client = TestClient(app)

print("=" * 60)
print("DSH 股票插件后端 - 冒烟测试")
print("=" * 60)

tests = [
    ("健康检查", "GET", "/health", None),
    ("指数行情", "GET", "/api/index-quotes", None),
    ("选股类型", "GET", "/api/screen/types", None),
    ("持仓列表", "GET", "/api/holdings", None),
    ("预警列表", "GET", "/api/alerts", None),
    ("单股行情（可能失败）", "GET", "/api/quote/600519", None),
    ("K线（可能失败）", "GET", "/api/kline/600519?count=10", None),
    ("启动股选股（可能失败）", "POST", "/api/screen", {"screen_type": "breakout", "max_results": 5}),
]

passed = 0
failed = 0

for name, method, path, body in tests:
    print(f"\n[TEST] {name}...")
    try:
        if method == "GET":
            resp = client.get(path)
        else:
            resp = client.post(path, json=body)

        status = resp.status_code
        if status == 200:
            data = resp.json()
            print(f"  [OK] {status} - 响应正常")
            print(f"  数据预览: {str(data)[:150]}...")
            passed += 1
        else:
            print(f"  [WARN] {status} - 响应异常（可能因无通达信连接）")
            failed += 1
    except Exception as e:
        print(f"  [FAIL] {e}")
        failed += 1

print("\n" + "=" * 60)
print(f"测试完成: {passed} 通过, {failed} 失败")
print("=" * 60)
print("\n提示: 失败项多为需要连接通达信行情服务器")
print("      启动后端后访问 http://127.0.0.1:8765/docs 测试")
