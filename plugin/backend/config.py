"""
运行配置：数据目录内的 config.json，热生效

可配置项：
- custom_tdx_hosts: 自定义通达信服务器列表 ["ip:port", ...]，优先于内置列表探测
- alert_interval:   预警检查间隔（秒）
- alert_cooldown:   同一预警冷却（秒）
- warm_interval:    全市场预热完整一轮后的等待间隔（秒）
- data_dir:         只读展示（实际切换走 storage/系统接口，不在此保存）
"""

import json
import time
from typing import Any, Dict, List

from loguru import logger

from storage import storage

DEFAULTS: Dict[str, Any] = {
    "custom_tdx_hosts": [],
    "alert_interval": 30,
    "alert_cooldown": 300,
    "warm_interval": 3600,
    "tdx_install_dir": "",   # 通达信安装目录（本地 vipdoc 数据源）
    "tdx_username": "",      # 可选：客户端弹登录框时自动填入（明文保存，见界面提示）
    "tdx_password": "",
}


class Config:
    """配置读写（内存缓存 + 文件持久化）"""

    def __init__(self):
        self._data: Dict[str, Any] = dict(DEFAULTS)
        self.load()

    def load(self):
        p = storage.path("config.json")
        if p.exists():
            try:
                stored = json.loads(p.read_text(encoding="utf-8"))
                self._data.update({k: v for k, v in stored.items() if k in DEFAULTS})
            except Exception as e:
                logger.error(f"加载配置失败: {e}")

    def save(self):
        try:
            storage.path("config.json").write_text(
                json.dumps(self._data, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception as e:
            logger.error(f"保存配置失败: {e}")

    # ---------- 访问 ----------

    def get(self, key: str, default=None):
        return self._data.get(key, DEFAULTS.get(key, default))

    def as_dict(self) -> Dict[str, Any]:
        d = dict(self._data)
        d["data_dir"] = str(storage.data_dir)  # 展示用
        return d

    def update(self, changes: Dict[str, Any]) -> Dict[str, Any]:
        """部分更新并持久化，返回生效后的完整配置"""
        for k, v in changes.items():
            if k in DEFAULTS and v is not None:
                self._data[k] = v
        self.save()
        return self.as_dict()

    # ---------- 类型化访问 ----------

    @property
    def custom_tdx_hosts(self) -> List[tuple]:
        hosts = []
        for item in self._data.get("custom_tdx_hosts") or []:
            try:
                ip, port = str(item).rsplit(":", 1)
                hosts.append((ip, int(port)))
            except ValueError:
                logger.warning(f"忽略无效服务器地址: {item}")
        return hosts

    @property
    def alert_interval(self) -> int:
        return max(5, int(self._data.get("alert_interval", 30)))

    @property
    def alert_cooldown(self) -> int:
        return max(30, int(self._data.get("alert_cooldown", 300)))

    @property
    def warm_interval(self) -> int:
        return max(600, int(self._data.get("warm_interval", 3600)))

    @property
    def tdx_install_dir(self) -> str:
        return str(self._data.get("tdx_install_dir") or "")

    @property
    def tdx_credentials(self) -> tuple:
        return (str(self._data.get("tdx_username") or ""),
                str(self._data.get("tdx_password") or ""))


config = Config()
