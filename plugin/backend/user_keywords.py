"""
用户自定义关键词管理模块

提供：
- 用户自定义关键词CRUD操作
- 股票关键词监控
- 黑名单管理
- 关键词分类管理
- JSON数据持久化
"""

import json
import uuid
from typing import List, Dict, Any, Optional
from datetime import datetime
from pathlib import Path
from loguru import logger


class UserKeywords:
    """用户自定义关键词管理"""
    
    def __init__(self, data_file: Optional[str] = None):
        """
        初始化用户关键词管理
        
        Args:
            data_file: 数据文件路径，默认使用数据目录下的sentiment_user_keywords.json
        """
        if data_file is None:
            from storage import storage
            self.data_file = storage.data_dir / "sentiment_user_keywords.json"
        else:
            self.data_file = Path(data_file)
        
        self.data = None
        self._load_data()
    
    def _load_data(self):
        """加载用户关键词数据"""
        try:
            if self.data_file.exists():
                with open(self.data_file, 'r', encoding='utf-8') as f:
                    self.data = json.load(f)
                logger.info(f"用户关键词数据加载成功: {len(self.data.get('custom_keywords', []))} 条")
            else:
                # 创建新数据结构
                self.data = self._create_default_data()
                self._save_data()
        except Exception as e:
            logger.error(f"用户关键词数据加载失败: {e}")
            self.data = self._create_default_data()
    
    def _create_default_data(self) -> Dict[str, Any]:
        """创建默认数据结构"""
        return {
            "version": "1.0",
            "last_updated": datetime.now().isoformat(),
            "custom_keywords": [],
            "stock_keywords": {},
            "blacklist": ["广告", "软文", "推广", "赞助"],
            "categories": {
                "个人关注股票": {"description": "用户持仓或关注的股票相关关键词"},
                "关注板块": {"description": "用户重点关注的行业板块"},
                "政策类型": {"description": "特定类型的政策事件"},
                "自定义": {"description": "用户自定义分类"},
            }
        }
    
    def _save_data(self):
        """保存用户关键词数据"""
        try:
            self.data["last_updated"] = datetime.now().isoformat()
            with open(self.data_file, 'w', encoding='utf-8') as f:
                json.dump(self.data, f, ensure_ascii=False, indent=2)
            logger.debug("用户关键词数据保存成功")
        except Exception as e:
            logger.error(f"用户关键词数据保存失败: {e}")
    
    def add_keyword(
        self, 
        keyword: str, 
        category: str = "自定义",
        importance: int = 70,
        notes: str = ""
    ) -> Dict[str, Any]:
        """
        添加自定义关键词
        
        Args:
            keyword: 关键词
            category: 分类
            importance: 重要性 (0-100)
            notes: 备注说明
        
        Returns:
            添加的关键词信息
        """
        # 生成唯一ID
        keyword_id = f"user_{uuid.uuid4().hex[:8]}"
        
        keyword_data = {
            "id": keyword_id,
            "keyword": keyword,
            "category": category,
            "importance": max(0, min(importance, 100)),  # 限制在0-100范围
            "notes": notes,
            "created_at": datetime.now().isoformat(),
            "updated_at": datetime.now().isoformat(),
        }
        
        self.data["custom_keywords"].append(keyword_data)
        self._save_data()
        
        logger.info(f"添加用户关键词: {keyword} (重要性: {importance})")
        return keyword_data
    
    def delete_keyword(self, keyword_id: str) -> bool:
        """
        删除自定义关键词
        
        Args:
            keyword_id: 关键词ID
        
        Returns:
            是否删除成功
        """
        original_length = len(self.data["custom_keywords"])
        self.data["custom_keywords"] = [
            kw for kw in self.data["custom_keywords"] 
            if kw["id"] != keyword_id
        ]
        
        if len(self.data["custom_keywords"]) < original_length:
            self._save_data()
            logger.info(f"删除用户关键词: {keyword_id}")
            return True
        
        return False
    
    def update_keyword(
        self, 
        keyword_id: str,
        keyword: Optional[str] = None,
        category: Optional[str] = None,
        importance: Optional[int] = None,
        notes: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """
        更新自定义关键词
        
        Args:
            keyword_id: 关键词ID
            keyword: 新关键词（可选）
            category: 新分类（可选）
            importance: 新重要性（可选）
            notes: 新备注（可选）
        
        Returns:
            更新后的关键词信息，不存在返回None
        """
        for kw in self.data["custom_keywords"]:
            if kw["id"] == keyword_id:
                if keyword is not None:
                    kw["keyword"] = keyword
                if category is not None:
                    kw["category"] = category
                if importance is not None:
                    kw["importance"] = max(0, min(importance, 100))
                if notes is not None:
                    kw["notes"] = notes
                kw["updated_at"] = datetime.now().isoformat()
                
                self._save_data()
                logger.info(f"更新用户关键词: {keyword_id}")
                return kw
        
        return None
    
    def get_all_keywords(self) -> List[Dict[str, Any]]:
        """获取所有自定义关键词"""
        return self.data.get("custom_keywords", [])
    
    def get_keyword_by_id(self, keyword_id: str) -> Optional[Dict[str, Any]]:
        """根据ID获取关键词"""
        for kw in self.data.get("custom_keywords", []):
            if kw["id"] == keyword_id:
                return kw
        return None
    
    def find_matching_keywords(self, text: str, min_importance: int = 0) -> List[Dict[str, Any]]:
        """
        在文本中查找匹配的用户关键词
        
        Args:
            text: 待搜索的文本
            min_importance: 最低重要性
        
        Returns:
            匹配的关键词列表
        """
        matched = []
        
        for kw in self.data.get("custom_keywords", []):
            if kw["importance"] >= min_importance and kw["keyword"] in text:
                matched.append({
                    "keyword": kw["keyword"],
                    "category": kw["category"],
                    "importance": kw["importance"],
                    "notes": kw.get("notes", ""),
                    "id": kw["id"],
                })
        
        # 按重要性排序
        matched.sort(key=lambda x: x["importance"], reverse=True)
        return matched
    
    def add_stock_watch(
        self, 
        stock_code: str, 
        stock_name: str,
        keywords: List[str]
    ) -> Dict[str, Any]:
        """
        为股票添加关键词监控
        
        Args:
            stock_code: 股票代码
            stock_name: 股票名称
            keywords: 监控关键词列表
        
        Returns:
            股票监控信息
        """
        stock_data = {
            "code": stock_code,
            "name": stock_name,
            "keywords": keywords,
            "created_at": datetime.now().isoformat(),
            "updated_at": datetime.now().isoformat(),
        }
        
        self.data["stock_keywords"][stock_code] = stock_data
        self._save_data()
        
        logger.info(f"为股票 {stock_name}({stock_code}) 添加关键词监控: {keywords}")
        return stock_data
    
    def get_stock_keywords(self, stock_code: str) -> Optional[Dict[str, Any]]:
        """获取股票的监控关键词"""
        return self.data.get("stock_keywords", {}).get(stock_code)
    
    def get_all_stock_watches(self) -> List[Dict[str, Any]]:
        """获取所有股票关键词监控"""
        return list(self.data.get("stock_keywords", {}).values())
    
    def remove_stock_watch(self, stock_code: str) -> bool:
        """删除股票关键词监控"""
        if stock_code in self.data.get("stock_keywords", {}):
            del self.data["stock_keywords"][stock_code]
            self._save_data()
            logger.info(f"删除股票关键词监控: {stock_code}")
            return True
        return False
    
    def add_blacklist(self, keyword: str) -> bool:
        """添加黑名单关键词"""
        if keyword not in self.data.get("blacklist", []):
            self.data["blacklist"].append(keyword)
            self._save_data()
            logger.info(f"添加黑名单关键词: {keyword}")
            return True
        return False
    
    def remove_blacklist(self, keyword: str) -> bool:
        """移除黑名单关键词"""
        blacklist = self.data.get("blacklist", [])
        if keyword in blacklist:
            blacklist.remove(keyword)
            self._save_data()
            logger.info(f"移除黑名单关键词: {keyword}")
            return True
        return False
    
    def get_blacklist(self) -> List[str]:
        """获取黑名单"""
        return self.data.get("blacklist", [])
    
    def is_blacklisted(self, text: str) -> bool:
        """检查文本是否包含黑名单词汇"""
        for blacklist_word in self.data.get("blacklist", []):
            if blacklist_word in text:
                return True
        return False
    
    def add_category(self, category_name: str, description: str = "") -> Dict[str, Any]:
        """添加关键词分类"""
        category_data = {
            "description": description
        }
        self.data["categories"][category_name] = category_data
        self._save_data()
        
        logger.info(f"添加关键词分类: {category_name}")
        return category_data
    
    def get_categories(self) -> Dict[str, Dict[str, str]]:
        """获取所有分类"""
        return self.data.get("categories", {})
    
    def get_statistics(self) -> Dict[str, Any]:
        """获取统计信息"""
        custom_keywords = self.data.get("custom_keywords", [])
        stock_keywords = self.data.get("stock_keywords", {})
        blacklist = self.data.get("blacklist", [])
        categories = self.data.get("categories", {})
        
        # 按分类统计关键词数量
        category_stats = {}
        for kw in custom_keywords:
            category = kw.get("category", "未分类")
            category_stats[category] = category_stats.get(category, 0) + 1
        
        return {
            "total_custom_keywords": len(custom_keywords),
            "total_stock_watches": len(stock_keywords),
            "total_blacklist": len(blacklist),
            "total_categories": len(categories),
            "category_distribution": category_stats,
            "last_updated": self.data.get("last_updated", ""),
            "version": self.data.get("version", "unknown"),
        }
    
    def export_data(self) -> Dict[str, Any]:
        """导出用户数据（用于备份或迁移）"""
        return {
            "export_time": datetime.now().isoformat(),
            "data": self.data,
            "statistics": self.get_statistics(),
        }
    
    def import_data(self, imported_data: Dict[str, Any], merge: bool = True) -> bool:
        """
        导入用户数据
        
        Args:
            imported_data: 导入的数据
            merge: 是否合并（True）还是覆盖（False）
        
        Returns:
            是否导入成功
        """
        try:
            if not merge:
                # 完全覆盖
                self.data = imported_data
            else:
                # 合并数据
                # 合并自定义关键词（去重）
                existing_ids = {kw["id"] for kw in self.data.get("custom_keywords", [])}
                for kw in imported_data.get("custom_keywords", []):
                    if kw["id"] not in existing_ids:
                        self.data["custom_keywords"].append(kw)
                
                # 合并股票关键词
                self.data["stock_keywords"].update(imported_data.get("stock_keywords", {}))
                
                # 合并黑名单
                blacklist = set(self.data.get("blacklist", []))
                blacklist.update(imported_data.get("blacklist", []))
                self.data["blacklist"] = list(blacklist)
                
                # 合并分类
                self.data["categories"].update(imported_data.get("categories", {}))
            
            self._save_data()
            logger.info("用户数据导入成功")
            return True
        
        except Exception as e:
            logger.error(f"用户数据导入失败: {e}")
            return False
    
    def cleanup_duplicates(self) -> int:
        """清理重复的关键词"""
        seen_keywords = set()
        unique_keywords = []
        duplicates_count = 0
        
        for kw in self.data.get("custom_keywords", []):
            if kw["keyword"] not in seen_keywords:
                seen_keywords.add(kw["keyword"])
                unique_keywords.append(kw)
            else:
                duplicates_count += 1
        
        if duplicates_count > 0:
            self.data["custom_keywords"] = unique_keywords
            self._save_data()
            logger.info(f"清理了 {duplicates_count} 个重复关键词")
        
        return duplicates_count
    
    def optimize_data(self) -> Dict[str, Any]:
        """优化数据（清理重复、更新统计等）"""
        duplicates_removed = self.cleanup_duplicates()
        
        # 更新统计信息
        stats = self.get_statistics()
        
        # 清理无效分类
        valid_categories = set(kw.get("category", "未分类") for kw in self.data.get("custom_keywords", []))
        all_categories = set(self.data.get("categories", {}).keys())
        invalid_categories = all_categories - valid_categories - {"未分类"}
        
        for cat in invalid_categories:
            del self.data["categories"][cat]
        
        removed_categories = len(invalid_categories)
        if removed_categories > 0:
            self._save_data()
            logger.info(f"清理了 {removed_categories} 个无效分类")
        
        return {
            "duplicates_removed": duplicates_removed,
            "categories_removed": removed_categories,
            "current_stats": stats,
        }


# 全局实例
_user_keywords = None


def get_user_keywords() -> UserKeywords:
    """获取用户关键词管理全局实例"""
    global _user_keywords
    if _user_keywords is None:
        _user_keywords = UserKeywords()
    return _user_keywords