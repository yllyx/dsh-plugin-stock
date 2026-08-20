"""
后端服务冒烟测试
不依赖行情服务器也能跑通 API 框架；连接可用时验证真实数据。
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))

from fastapi.testclient import TestClient
from main import app

client = TestClient(app)

print("=" * 60)
print("DSH 股票插件后端 - 冒烟测试（0.3.0 交易体系版）")
print("=" * 60)

tests = [
    # 基础
    ("健康检查", "GET", "/health", None),
    ("指数行情", "GET", "/api/index-quotes", None),
    # 择时/情绪/板块
    ("大盘择时", "GET", "/api/market/timing", None),
    ("情绪+风格", "GET", "/api/market/sentiment", None),
    ("板块排行", "GET", "/api/sectors?board_type=industry&top_n=5", None),
    ("概念板块", "GET", "/api/sectors?board_type=concept&top_n=5", None),
    # 账户/仓位
    ("账户读取", "GET", "/api/account", None),
    ("仓位体检", "GET", "/api/position/overview", None),
    # 选股
    ("选股类型", "GET", "/api/screen/types", None),
    ("预热池状态", "GET", "/api/screen/pool-status", None),
    # 持仓/预警
    ("持仓列表", "GET", "/api/holdings", None),
    ("预警列表", "GET", "/api/alerts", None),
    ("预警历史", "GET", "/api/alerts/history", None),
    # 行情/K线（需数据源）
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
        data = resp.json()
        # 200 且不含 error 字段算通过；含 error 视为降级提示（不算崩溃）
        ok = status == 200 and not data.get("error")
        degraded = status == 200 and data.get("error")
        preview = str(data)[:120]
        if ok:
            print(f"  [OK] {status} - {preview}...")
            passed += 1
        elif degraded:
            print(f"  [DEGRADED] {status} - {data.get('error')}（数据源不可用，接口框架正常）")
            passed += 1
        else:
            print(f"  [FAIL] {status} - {preview}")
            failed += 1
    except Exception as e:
        print(f"  [FAIL] {type(e).__name__}: {e}")
        failed += 1

# 写操作链路（添加持仓→改模式→删）
print("\n[TEST] 持仓增改删链路...")
try:
    r1 = client.post("/api/holdings", json={
        "code": "600519", "name": "贵州茅台", "buy_price": 1500, "shares": 100,
        "stop_mode": "trailing", "trail_drawdown_pct": 8,
    })
    r2 = client.put("/api/holdings/600519", json={"stop_mode": "ladder"})
    r3 = client.delete("/api/holdings/600519")
    ok = r1.status_code == 200 and r2.status_code == 200 and r3.status_code == 200
    print(f"  [{'OK' if ok else 'FAIL'}] add={r1.status_code} update={r2.status_code} del={r3.status_code}")
    passed, failed = (passed + 1, failed) if ok else (passed, failed + 1)
except Exception as e:
    print(f"  [FAIL] {e}")
    failed += 1

# 预警规则增删
print("\n[TEST] 预警规则增删链路...")
try:
    r1 = client.post("/api/alerts", json={"code": "600519", "type": "price_above", "threshold": 1600})
    rules = client.get("/api/alerts").json().get("alerts", [])
    rule_id = rules[-1]["id"] if rules else None
    r2 = client.put(f"/api/alerts/{rule_id}", json={"enabled": False})
    r3 = client.delete(f"/api/alerts/{rule_id}")
    ok = r1.status_code == 200 and r2.status_code == 200 and r3.status_code == 200
    print(f"  [{'OK' if ok else 'FAIL'}] add={r1.status_code} toggle={r2.status_code} del={r3.status_code}")
    passed, failed = (passed + 1, failed) if ok else (passed, failed + 1)
except Exception as e:
    print(f"  [FAIL] {e}")
    failed += 1

# 账户设置
print("\n[TEST] 账户设置...")
try:
    r1 = client.put("/api/account", json={"total_capital": 1000000})
    r2 = client.get("/api/account").json()
    ok = r1.status_code == 200 and r2.get("total_capital") == 1000000
    print(f"  [{'OK' if ok else 'FAIL'}] 总资金={r2.get('total_capital')}")
    passed, failed = (passed + 1, failed) if ok else (passed, failed + 1)
except Exception as e:
    print(f"  [FAIL] {e}")
    failed += 1

print("\n" + "=" * 60)
print(f"测试完成: {passed} 通过, {failed} 失败")
print("=" * 60)
print("提示: DEGRADED 项为数据源暂时不可用（东财限流或通达信未连），接口本身正常")
print("      启动后端后访问 http://127.0.0.1:8765/docs 查看全部接口")
