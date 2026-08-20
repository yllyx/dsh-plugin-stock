"""
数据存储层：数据目录解析 / 迁移 / 路径管理

数据目录解析优先级：
1. 环境变量 STOCK_DATA_DIR
2. 指针文件 ~/.dsh/dsh-plugin-stock.dir （JSON: {"data_dir": "..."}）
3. 默认 ~/.dsh/stock-data/

所有用户数据（持仓/资金/配置/K线库）都存放在数据目录，
与插件包（node_modules 内）分离，插件升级不丢数据。
"""

import json
import os
import shutil
from pathlib import Path
from typing import Dict, List, Optional

from loguru import logger

# 受管理的数据文件
DATA_FILES = ["alerts.json", "account.json", "config.json", "market.db"]


def default_data_dir() -> Path:
    return Path.home() / ".dsh" / "stock-data"


def pointer_file() -> Path:
    return Path.home() / ".dsh" / "dsh-plugin-stock.dir"


def resolve_data_dir() -> Path:
    env = os.environ.get("STOCK_DATA_DIR")
    if env:
        return Path(env).expanduser().absolute()
    pf = pointer_file()
    if pf.exists():
        try:
            d = json.loads(pf.read_text(encoding="utf-8")).get("data_dir")
            if d:
                return Path(d).expanduser().absolute()
        except Exception:
            pass
    return default_data_dir()


class Storage:
    """数据目录管理（含切换迁移）"""

    def __init__(self):
        self.data_dir: Path = resolve_data_dir()
        self._ensure()
        self._migrate_legacy()

    # ---------- 基础 ----------

    def _ensure(self):
        try:
            self.data_dir.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            logger.error(f"数据目录不可用 {self.data_dir}: {e}")

    def path(self, name: str) -> Path:
        return self.data_dir / name

    # ---------- 旧位置自动迁移 ----------

    def _migrate_legacy(self):
        """插件包内 backend/ 目录的旧数据文件 → 数据目录（仅目标缺失时复制，不覆盖）"""
        legacy = Path(__file__).parent
        copied = []
        for f in DATA_FILES:
            src = legacy / f
            dst = self.path(f)
            if src.exists() and not dst.exists():
                try:
                    shutil.copy2(src, dst)
                    copied.append(f)
                except Exception as e:
                    logger.warning(f"迁移 {f} 失败: {e}")
        if copied:
            logger.info(f"已从插件包内迁移数据文件到 {self.data_dir}: {copied}")

    # ---------- 切换数据目录 ----------

    def switch_dir(self, new_dir: str) -> Dict[str, any]:
        """
        切换数据目录：校验可写 → 复制迁移（不覆盖同名）→ 写指针 → 更新内存路径。
        复制而非移动：新目录出问题时旧目录数据完好。
        注意：market.db 如有打开的连接，调用方应先关闭（传入 db_close/db_open 回调）。
        """
        new = Path(new_dir).expanduser().absolute()
        new.mkdir(parents=True, exist_ok=True)

        # 可写校验
        test_file = new / ".write-test"
        test_file.write_text("ok", encoding="utf-8")
        test_file.unlink()

        old = self.data_dir
        if new == old:
            return {"old": str(old), "new": str(new), "copied": [], "skipped": [],
                    "message": "新目录与当前目录相同"}

        copied: List[str] = []
        skipped: List[str] = []
        for f in DATA_FILES:
            src = old / f
            dst = new / f
            if not src.exists():
                continue
            if dst.exists():
                skipped.append(f)  # 目标已有同名文件，不覆盖
                continue
            try:
                shutil.copy2(src, dst)
                copied.append(f)
            except Exception as e:
                skipped.append(f"{f}(复制失败:{e})")

        # 切换内存路径并写指针
        self.data_dir = new
        pointer_file().parent.mkdir(parents=True, exist_ok=True)
        pointer_file().write_text(
            json.dumps({"data_dir": str(new)}, ensure_ascii=False, indent=2),
            encoding="utf-8")

        logger.info(f"数据目录已切换: {old} → {new}（复制 {copied}，跳过 {skipped}）")
        return {"old": str(old), "new": str(new), "copied": copied, "skipped": skipped}

    def dir_info(self) -> Dict[str, any]:
        files = []
        for f in DATA_FILES:
            p = self.path(f)
            files.append({
                "name": f,
                "exists": p.exists(),
                "size": p.stat().st_size if p.exists() else 0,
            })
        return {"data_dir": str(self.data_dir), "files": files}


storage = Storage()
