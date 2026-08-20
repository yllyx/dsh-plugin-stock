"""
系统管理 API：状态总览 / 通达信服务器体检 / 强制重连 / 配置 / 日志 / 自重启
"""

import asyncio
import os
import subprocess
import sys
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Dict, List

from fastapi import HTTPException, Request
from loguru import logger
from pydantic import BaseModel

from config import config
from storage import storage
from data_source import data_source
from screener import market_pool
from ws_manager import ws_manager

BACKEND_DIR = Path(__file__).parent
START_TIME = time.time()
PLUGIN_VERSION = "0.3.1"

# ============= 内存日志环形缓冲 =============
LOG_BUFFER: deque = deque(maxlen=500)


def log_sink(message):
    """loguru sink：截取最近500条到内存，供 /api/system/logs 查看"""
    rec = message.record
    LOG_BUFFER.append({
        "time": rec["time"].strftime("%H:%M:%S"),
        "level": rec["level"].name,
        "module": rec["name"],
        "text": rec["message"],
    })


def install_log_sink():
    logger.add(log_sink, level="INFO", enqueue=False)


# ============= 数据模型 =============
class ConfigUpdate(BaseModel):
    custom_tdx_hosts: List[str] = None
    alert_interval: int = None
    alert_cooldown: int = None
    warm_interval: int = None
    data_dir: str = None  # 单独处理：走迁移流程
    tdx_install_dir: str = None
    tdx_username: str = None
    tdx_password: str = None


# ============= 状态总览 =============
async def system_status() -> Dict[str, Any]:
    from tdx_local import local_status
    pool = market_pool.status()
    return {
        "plugin_version": PLUGIN_VERSION,
        "uptime_sec": round(time.time() - START_TIME),
        "python": sys.version.split()[0],
        "tdx": {
            "connected": data_source.connected,
            "current_host": data_source.current_host,
            "custom_hosts": config.get("custom_tdx_hosts"),
        },
        "market_pool": pool,
        "websocket_clients": len(ws_manager.active_connections),
        "data_dir": storage.dir_info(),
        "tdx_local": local_status(config.tdx_install_dir),
        "tdx_client_running": _tdx_client_running(),
    }


def _tdx_client_running() -> bool:
    try:
        out = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq tdxw.exe", "/FO", "CSV", "/NH"],
            capture_output=True, text=True, timeout=5).stdout
        return "tdxw.exe" in out.lower()
    except Exception:
        return False


# ============= 通达信客户端：启动 / 自动登录 / 盘后数据更新 =============

_watch_state = {"running": False}


async def tdx_client_update() -> Dict[str, Any]:
    """
    启动通达信客户端并尽力拉取最新本地数据：
    1. 启动 tdxw.exe（行情免费，通常无需登录）
    2. 若配置了账号密码且弹出登录框 → 尝试自动填入（pywinauto 可选依赖）
    3. 尽力自动触发「盘后数据下载」（自绘界面，成功率有限；失败提示手动）
    4. 后台监测 vipdoc 文件变化，检测到新数据自动重新载入内存+SQLite
    """
    from tdx_local import find_tdx_exe, resolve_vipdoc_dir, vipdoc_signature, local_status
    from screener import market_pool as pool_ref

    exe = find_tdx_exe(config.tdx_install_dir)
    if not exe:
        return {"ok": False,
                "message": "未找到 tdxw.exe，请先在配置中填写正确的通达信安装目录"}

    status_before = local_status(config.tdx_install_dir)
    sig_before = vipdoc_signature(resolve_vipdoc_dir(config.tdx_install_dir))

    if _tdx_client_running():
        already = "客户端已在运行"
    else:
        try:
            subprocess.Popen(
                [str(exe)], cwd=str(exe.parent),
                creationflags=0x208,  # 分离进程，不随本后端退出
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
        except Exception as e:
            return {"ok": False, "message": f"启动客户端失败: {e}"}
        already = "客户端已启动"

    # 后台线程：自动登录尝试 + 盘后下载尽力触发 + 变化监测
    def _bg():
        notes = []
        time.sleep(8)  # 等客户端起来
        username, password = config.tdx_credentials
        if username and password:
            ok, note = _try_auto_login(username, password)
            notes.append(note)
        # 尽力触发盘后下载（可选依赖，失败仅提示）
        notes.append(_try_trigger_download())
        await_note = " ".join(n for n in notes if n)
        # vipdoc 变化监测（最多30分钟）：文件数/mtime 变化即重载
        watched = 0
        while watched < 1800:
            time.sleep(10)
            watched += 10
            sig = vipdoc_signature(resolve_vipdoc_dir(config.tdx_install_dir))
            if sig != sig_before:
                time.sleep(20)  # 等写入完成
                n = pool_ref.load_local_tdx()
                logger.info(f"检测到通达信新数据，已重新载入 {n} 只")
                return
        logger.info("通达信数据监测结束（30分钟无新数据）")

    threading.Thread(target=_bg, daemon=True).start()

    return {
        "ok": True,
        "message": (f"{already}。若数据未自动更新，请在客户端中手动执行："
                    f"系统 → 盘后数据下载 → 勾选日线/分钟线 → 开始下载。"
                    f"下载完成后插件自动载入（30分钟内自动检测）。"),
        "local_status": status_before,
    }


def _try_auto_login(username: str, password: str) -> tuple:
    """尽力自动填写登录框（pywinauto 可选依赖；通达信行情通常免登录）"""
    try:
        from pywinauto import Desktop
    except ImportError:
        return False, "（未安装 pywinauto，跳过自动登录；行情数据通常无需登录）"
    try:
        wins = Desktop(backend="uia").windows()
        for w in wins:
            title = (w.window_text() or "")
            if "登录" in title or "login" in title.lower():
                # 尽力找用户名/密码编辑框
                for edt in w.descendants(control_type="Edit"):
                    txt = edt.window_text()
                    if not txt:
                        edt.type_keys(password if edt.element_info.automation_id().endswith("2")
                                      else username, with_spaces=True)
                for btn in w.descendants(control_type="Button"):
                    if "登录" in (btn.window_text() or "") or "确定" in (btn.window_text() or ""):
                        btn.invoke()
                        return True, "（已尝试自动登录）"
        return False, ""
    except Exception as e:
        logger.debug(f"自动登录尝试失败: {e}")
        return False, ""


def _try_trigger_download() -> str:
    """尽力自动触发盘后数据下载（通达信自绘界面，成功率有限）"""
    try:
        from pywinauto import Desktop
    except ImportError:
        return "（未安装 pywinauto，无法自动触发下载，请手动：系统→盘后数据下载）"
    try:
        import pywinauto.keyboard as kb
        wins = Desktop(backend="uia").windows()
        main = None
        for w in wins:
            if "通达信" in (w.window_text() or "") or "tdx" in (w.window_text() or "").lower():
                main = w
                break
        if main is None:
            return "（未找到通达信主窗口，请手动：系统→盘后数据下载）"
        main.set_focus()
        # 盘后下载常用快捷路径：菜单 系统(位置11)→ 盘后数据下载；尝试发送按键序列
        kb.send_keys("%{F1}")          # 部分版本呼出功能导航
        time.sleep(1)
        kb.send_keys("{ESC}")
        return "（已尝试快捷键触发盘后下载；若无反应请手动：系统→盘后数据下载）"
    except Exception as e:
        logger.debug(f"盘后下载触发失败: {e}")
        return "（自动触发失败，请手动：系统→盘后数据下载）"


# ============= 通达信服务器体检 =============

def _probe_host(ip: str, port: int, timeout: float = 2.5) -> Dict[str, Any]:
    from pytdx.hq import TdxHq_API
    api = TdxHq_API()
    start = time.time()
    try:
        api.connect(ip, port, time_out=timeout)
        q = api.get_security_quotes([(1, "600519")])
        latency = round((time.time() - start) * 1000)
        api.disconnect()
        if q and q[0].get("price"):
            return {"host": f"{ip}:{port}", "status": "ok", "latency_ms": latency}
        return {"host": f"{ip}:{port}", "status": "no_data", "latency_ms": latency}
    except Exception:
        return {"host": f"{ip}:{port}", "status": "timeout", "latency_ms": round((time.time() - start) * 1000)}


async def tdx_probe() -> Dict[str, Any]:
    """并行探测 内置前15台 + 自定义服务器"""
    from pytdx.config.hosts import hq_hosts
    targets = []
    for h in hq_hosts[:15]:
        ip, port = (h[1], h[2]) if not isinstance(h, dict) else (h["ip"], h["port"])
        targets.append((ip, port))
    for ip, port in config.custom_tdx_hosts:
        targets.append((ip, port))

    loop = asyncio.get_event_loop()
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [loop.run_in_executor(pool, _probe_host, ip, p) for ip, p in targets]
        results = await asyncio.gather(*futures)

    ok = [r for r in results if r["status"] == "ok"]
    ok.sort(key=lambda r: r["latency_ms"])
    return {
        "results": results,
        "ok_count": len(ok),
        "total": len(results),
        "best": ok[0] if ok else None,
    }


# ============= 强制重连 =============
async def tdx_reconnect() -> Dict[str, Any]:
    loop = asyncio.get_event_loop()

    def do_reconnect():
        data_source.disconnect()
        return data_source.connect()

    ok = await loop.run_in_executor(None, do_reconnect)
    return {
        "connected": data_source.connected,
        "current_host": data_source.current_host,
        "message": "重连成功" if ok else "重连失败（可在服务器体检中查看可用节点）",
    }


# ============= 配置 =============
async def get_config() -> Dict[str, Any]:
    return config.as_dict()


async def update_config(req: ConfigUpdate, request: Request) -> Dict[str, Any]:
    changes = {k: v for k, v in req.dict().items() if v is not None and k != "data_dir"}

    # 数据目录切换：迁移流程
    if req.data_dir:
        from alert_engine import alert_engine
        from position_manager import position_manager

        # 落盘当前状态 → 关K线库连接 → 复制迁移 → 切换路径 → 重载
        alert_engine.save()
        position_manager.save()
        market_pool.db_close()
        market_pool._db_upsert_buffer.clear()
        try:
            result = storage.switch_dir(req.data_dir)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"切换数据目录失败: {e}")
        # K线库从新位置重载（在线切换）
        await asyncio.to_thread(market_pool.db_reload)
        alert_engine.load()
        position_manager.load()
        config.load()
        result["message"] = "数据目录已切换并迁移完成（同名文件未覆盖，详见 skipped）"
        if changes:
            config.update(changes)
        return {"data_dir_result": result, "config": config.as_dict()}

    if not changes:
        return {"config": config.as_dict()}

    # 生效配置
    result = config.update(changes)
    # 自定义服务器变化时触发重连（后台执行，不阻塞响应）
    if "custom_tdx_hosts" in changes:
        data_source.disconnect()
    # 通达信目录变化时立即尝试载入本地数据（后台执行）
    if "tdx_install_dir" in changes:
        def _reload_local():
            try:
                n = market_pool.load_local_tdx()
                logger.info(f"通达信目录已更新，本地载入 {n} 只")
            except Exception as e:
                logger.warning(f"本地数据载入失败: {e}")
        threading.Thread(target=_reload_local, daemon=True).start()

    return {"config": result}


# ============= 日志 =============
async def get_logs(level: str = "INFO", limit: int = 200) -> Dict[str, Any]:
    order = {"DEBUG": 10, "INFO": 20, "WARNING": 30, "ERROR": 40}
    min_level = order.get(level.upper(), 20)
    logs = [x for x in LOG_BUFFER if order.get(x["level"], 20) >= min_level]
    return {"logs": logs[-limit:], "total": len(logs)}


# ============= 自重启 =============
async def restart_backend(request: Request) -> Dict[str, Any]:
    """
    自重启：spawn 一个分离的 helper 进程（等旧进程退出后重新拉起 uvicorn，
    带重试与日志），当前进程随后退出。前端靠 /health 轮询自动恢复显示。
    """
    port = request.url.port or 8765
    log_file = BACKEND_DIR / "restart.log"
    helper_code = (
        "import time, subprocess, sys\n"
        f"log = r'{log_file}'\n"
        "def w(msg):\n"
        "    with open(log, 'a', encoding='utf-8') as f: f.write(time.strftime('[%H:%M:%S] ') + msg + '\\n')\n"
        "w('helper started')\n"
        "for attempt in range(5):\n"
        "    time.sleep(3)\n"
        "    out = open(log, 'a', encoding='utf-8')\n"
        f"    p = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'main:app', "
        f"'--host', '127.0.0.1', '--port', '{port}', '--log-level', 'warning'], "
        f"cwd=r'{BACKEND_DIR}', creationflags=8, stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)\n"
        "    time.sleep(4)\n"
        "    if p.poll() is None:\n"
        "        w(f'attempt {attempt}: uvicorn alive pid={p.pid}')\n"
        "        break\n"
        "    w(f'attempt {attempt}: exited code={p.returncode}, retrying')\n"
    )
    # CREATE_NEW_PROCESS_GROUP(0x200) | DETACHED_PROCESS(0x8)：分离进程，不随父退出
    subprocess.Popen(
        [sys.executable, "-c", helper_code],
        cwd=str(BACKEND_DIR),
        creationflags=0x208,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
    )
    logger.warning(f"后端自重启（端口 {port}），helper 将在3秒后拉起新进程")

    # 落盘后延迟退出，给响应留时间
    from alert_engine import alert_engine
    from position_manager import position_manager
    alert_engine.save()
    position_manager.save()
    market_pool._db_flush()

    def _exit_soon():
        time.sleep(1.5)
        os._exit(0)

    threading.Thread(target=_exit_soon, daemon=True).start()
    return {"status": "restarting", "port": port, "message": "后端将在数秒后重启，页面自动恢复"}
