"""
舆情数据库管理模块

提供：
- SQLite数据库存储舆情历史数据
- 舆情CRUD操作
- 数据索引和查询优化
"""

import sqlite3
import json
import time
from typing import List, Dict, Any, Optional
from pathlib import Path
from datetime import datetime, timedelta
from loguru import logger


class SentimentDB:
    """舆情历史数据库管理"""
    
    def __init__(self, db_path: Optional[str] = None):
        """
        初始化数据库连接
        
        Args:
            db_path: 数据库文件路径，默认使用数据目录下的sentiment.db
        """
        if db_path is None:
            from storage import storage
            self.db_path = storage.data_dir / "sentiment.db"
        else:
            self.db_path = Path(db_path)
        
        self.conn = None
        self._connect()
        self._init_tables()
    
    def _connect(self):
        """建立数据库连接"""
        try:
            self.conn = sqlite3.connect(
                str(self.db_path),
                check_same_thread=False,
                timeout=10.0
            )
            self.conn.row_factory = sqlite3.Row
            logger.info(f"舆情数据库连接成功: {self.db_path}")
        except Exception as e:
            logger.error(f"舆情数据库连接失败: {e}")
            raise
    
    def _init_tables(self):
        """初始化数据库表结构"""
        # 舆情新闻表
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS sentiment_news (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,                    -- 数据源 (eastmoney/sina/caixin/fed/bloomberg等)
                title TEXT NOT NULL,                     -- 新闻标题
                content TEXT,                            -- 新闻内容摘要
                url TEXT UNIQUE,                         -- 新闻链接（去重用）
                published_at TIMESTAMP,                  -- 发布时间
                importance_score INTEGER DEFAULT 0,      -- 重要性评分 (0-100)
                sentiment_tag TEXT,                      -- 情感标签 (positive/negative/neutral)
                sector_tag TEXT,                         -- 归属板块
                related_stocks TEXT,                     -- 关联股票代码 (JSON数组)
                impact_level TEXT,                       -- 影响级别 (high/medium/low)
                event_type TEXT,                         -- 事件类型 (macro/policy/earnings/sector/market)
                country TEXT,                            -- 国家 (cn/us)
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        
        # 创建索引
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_source ON sentiment_news(source)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_published ON sentiment_news(published_at)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_importance ON sentiment_news(importance_score)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_event_type ON sentiment_news(event_type)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_country ON sentiment_news(country)")
        
        # 事件日历表
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS event_calendar (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_name TEXT NOT NULL,                -- 事件名称
                event_type TEXT NOT NULL,                -- 事件类型
                event_date DATE NOT NULL,                -- 事件日期
                event_time TIME,                         -- 事件时间（精确到分钟）
                timezone TEXT,                           -- 时区 (EST/CST)
                importance_score INTEGER DEFAULT 0,      -- 重要性评分
                description TEXT,                        -- 事件描述
                expected_impact TEXT,                    -- 预期影响
                actual_result TEXT,                       -- 实际结果（事件发生后填充）
                country TEXT,                            -- 国家 (cn/us)
                source_url TEXT,                         -- 数据源URL
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        
        # 创建事件日历索引
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_event_date ON event_calendar(event_date)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_event_type ON event_calendar(event_type)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_calendar_importance ON event_calendar(importance_score)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_calendar_country ON event_calendar(country)")
        
        # 历史影响统计表
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS impact_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL,                  -- 事件标识
                event_date DATE NOT NULL,                -- 事件发生日期
                event_description TEXT,                  -- 事件描述
                sector_code TEXT,                        -- 板块代码
                sector_name TEXT,                        -- 板块名称
                avg_change REAL,                         -- 平均涨跌幅 (%)
                win_rate REAL,                           -- 胜率 (0-1)
                samples_count INTEGER,                    -- 样本数量
                market_context TEXT,                     -- 市场环境 (JSON)
                max_gain REAL,                           -- 最大涨幅 (%)
                max_loss REAL,                           -- 最大跌幅 (%)
                confidence TEXT,                         -- 置信度 (high/medium/low)
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        
        # 创建影响历史索引
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_impact_event_id ON impact_history(event_id)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_impact_sector_code ON impact_history(sector_code)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_impact_event_date ON impact_history(event_date)")
        
        # 关键词映射表
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS keyword_mappings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                keyword TEXT NOT NULL,                    -- 关键词
                sector_code TEXT,                        -- 板块代码
                sector_name TEXT,                        -- 板块名称
                impact_type TEXT,                         -- 影响类型 (positive/negative/neutral)
                weight REAL DEFAULT 1.0,                  -- 权重系数
                sample_count INTEGER DEFAULT 0,           -- 样本数量
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(keyword, sector_code)
            )
        """)
        
        # 创建关键词映射索引
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_keyword ON keyword_mappings(keyword)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_keyword_sector ON keyword_mappings(sector_code)")
        
        # 用户自定义关键词表
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS user_keywords (
                id TEXT PRIMARY KEY,                     -- 关键词ID (user_xxx)
                keyword TEXT NOT NULL,                    -- 关键词
                category TEXT,                           -- 分类
                importance INTEGER DEFAULT 70,            -- 重要性 (0-100)
                notes TEXT,                              -- 备注
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        
        # 创建用户关键词索引
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_user_keyword ON user_keywords(keyword)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_user_category ON user_keywords(category)")
        
        # 板块成分股表
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS sector_stocks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sector_code TEXT NOT NULL,                -- 板块代码
                sector_name TEXT NOT NULL,                -- 板块名称
                stock_code TEXT NOT NULL,                 -- 股票代码
                stock_name TEXT NOT NULL,                 -- 股票名称
                weight REAL DEFAULT 1.0,                  -- 权重（市值权重）
                is_leader BOOLEAN DEFAULT 0,             -- 是否龙头股
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(sector_code, stock_code)
            )
        """)
        
        # 创建板块成分股索引
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_sector_sector_code ON sector_stocks(sector_code)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_sector_stock_code ON sector_stocks(stock_code)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_sector_leader ON sector_stocks(is_leader)")
        
        # 舆情-板块关联记录表
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS sentiment_sector_relations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sentiment_id INTEGER NOT NULL,            -- 舆情ID
                sector_code TEXT NOT NULL,                -- 板块代码
                sector_name TEXT NOT NULL,                -- 板块名称
                relevance_score REAL DEFAULT 0,          -- 相关度评分 (0-100)
                impact_direction TEXT,                    -- 影响方向 (positive/negative/neutral)
                reasoning TEXT,                          -- 关联理由
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (sentiment_id) REFERENCES sentiment_news(id) ON DELETE CASCADE
            )
        """)
        
        # 创建舆情-板块关联索引
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_relation_sentiment_id ON sentiment_sector_relations(sentiment_id)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_relation_sector_code ON sentiment_sector_relations(sector_code)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_relation_relevance ON sentiment_sector_relations(relevance_score)")
        
        self.conn.commit()
        logger.info("舆情数据库表结构初始化完成")
    
    def save_news(self, news_list: List[Dict[str, Any]]) -> int:
        """
        批量保存舆情新闻，自动去重
        
        Args:
            news_list: 舆情新闻列表
            
        Returns:
            成功保存的数量
        """
        saved_count = 0
        for news in news_list:
            try:
                # 准备数据
                data = {
                    'source': news.get('source', 'unknown'),
                    'title': news.get('title', ''),
                    'content': news.get('content', ''),
                    'url': news.get('url', None),
                    'published_at': news.get('published_at'),
                    'importance_score': news.get('importance_score', 0),
                    'sentiment_tag': news.get('sentiment_tag', 'neutral'),
                    'sector_tag': news.get('sector_tag', None),
                    'related_stocks': json.dumps(news.get('related_stocks', []), ensure_ascii=False),
                    'impact_level': news.get('impact_level', 'medium'),
                    'event_type': news.get('event_type', 'general'),
                    'country': news.get('country', 'cn'),
                }
                
                # 尝试插入
                self.conn.execute("""
                    INSERT OR IGNORE INTO sentiment_news 
                    (source, title, content, url, published_at, importance_score, 
                     sentiment_tag, sector_tag, related_stocks, impact_level, event_type, country)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    data['source'], data['title'], data['content'], data['url'],
                    data['published_at'], data['importance_score'], data['sentiment_tag'],
                    data['sector_tag'], data['related_stocks'], data['impact_level'],
                    data['event_type'], data['country']
                ))
                
                saved_count += 1
                
            except sqlite3.IntegrityError:
                # URL重复，跳过
                continue
            except Exception as e:
                logger.warning(f"保存舆情失败: {e}, 数据: {news.get('title', 'unknown')[:50]}")
                continue
        
        self.conn.commit()
        return saved_count
    
    def get_latest_news(self, limit: int = 50, min_score: int = 0) -> List[Dict[str, Any]]:
        """
        获取最新舆情
        
        Args:
            limit: 返回数量
            min_score: 最低重要性评分
            
        Returns:
            舆情新闻列表
        """
        cursor = self.conn.execute("""
            SELECT * FROM sentiment_news 
            WHERE importance_score >= ?
            ORDER BY published_at DESC 
            LIMIT ?
        """, (min_score, limit))
        
        rows = cursor.fetchall()
        results = []
        for row in rows:
            news = dict(row)
            # 解析JSON字段
            if news['related_stocks']:
                try:
                    news['related_stocks'] = json.loads(news['related_stocks'])
                except:
                    news['related_stocks'] = []
            results.append(news)
        
        return results

    def get_news_by_id(self, news_id) -> Optional[Dict[str, Any]]:
        """根据ID获取单条舆情（related_sectors/related_stocks 解析为对象）"""
        cursor = self.conn.execute(
            "SELECT * FROM sentiment_news WHERE id = ?", (news_id,)
        )
        row = cursor.fetchone()
        if row is None:
            return None
        news = dict(row)
        for field in ('related_sectors', 'related_stocks'):
            if news.get(field):
                try:
                    news[field] = json.loads(news[field])
                except (ValueError, TypeError):
                    news[field] = []
            else:
                news[field] = []
        return news

    def get_by_source(self, source: str, limit: int = 30) -> List[Dict[str, Any]]:
        """根据数据源获取舆情"""
        cursor = self.conn.execute("""
            SELECT * FROM sentiment_news 
            WHERE source = ?
            ORDER BY published_at DESC 
            LIMIT ?
        """, (source, limit))
        
        return [dict(row) for row in cursor.fetchall()]
    
    def get_by_country(self, country: str, limit: int = 30) -> List[Dict[str, Any]]:
        """根据国家获取舆情"""
        cursor = self.conn.execute("""
            SELECT * FROM sentiment_news 
            WHERE country = ?
            ORDER BY published_at DESC 
            LIMIT ?
        """, (country, limit))
        
        return [dict(row) for row in cursor.fetchall()]
    
    def get_by_event_type(self, event_type: str, limit: int = 30) -> List[Dict[str, Any]]:
        """根据事件类型获取舆情"""
        cursor = self.conn.execute("""
            SELECT * FROM sentiment_news 
            WHERE event_type = ?
            ORDER BY published_at DESC 
            LIMIT ?
        """, (event_type, limit))
        
        return [dict(row) for row in cursor.fetchall()]
    
    def get_events_by_date_range(
        self, 
        start_date: Optional[str] = None, 
        end_date: Optional[str] = None,
        country: Optional[str] = None,
        min_importance: int = 0
    ) -> List[Dict[str, Any]]:
        """
        获取日期范围内的事件
        
        Args:
            start_date: 开始日期 (YYYY-MM-DD)
            end_date: 结束日期 (YYYY-MM-DD)
            country: 国家筛选
            min_importance: 最低重要性
            
        Returns:
            事件列表
        """
        if not start_date:
            start_date = datetime.now().strftime('%Y-%m-%d')
        if not end_date:
            end_date = (datetime.now() + timedelta(days=30)).strftime('%Y-%m-%d')
        
        query = """
            SELECT * FROM event_calendar 
            WHERE event_date >= ? AND event_date <= ?
            AND importance_score >= ?
        """
        params = [start_date, end_date, min_importance]
        
        if country:
            query += " AND country = ?"
            params.append(country)
        
        query += " ORDER BY event_date ASC, event_time ASC"
        
        cursor = self.conn.execute(query, params)
        return [dict(row) for row in cursor.fetchall()]
    
    def save_events(self, events: List[Dict[str, Any]]) -> int:
        """批量保存事件日历（兼容规则源的 name/category 与爬虫源的 event_name/event_type）"""
        saved_count = 0
        for event in events:
            try:
                event_name = event.get('event_name') or event.get('name')
                event_type = event.get('event_type') or event.get('category') or 'general'
                if not event_name:
                    continue
                # 去重：同名同日同时已存在则跳过（表无唯一约束，重复生成不重复入库）
                exists = self.conn.execute(
                    "SELECT 1 FROM event_calendar WHERE event_name=? AND event_date=? AND IFNULL(event_time,'')=IFNULL(?,'') LIMIT 1",
                    (event_name, event.get('event_date'), event.get('event_time'))
                ).fetchone()
                if exists:
                    continue
                self.conn.execute("""
                    INSERT OR REPLACE INTO event_calendar
                    (event_name, event_type, event_date, event_time, timezone,
                     importance_score, description, expected_impact, country, source_url)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    event_name,
                    event_type,
                    event.get('event_date'),
                    event.get('event_time'),
                    event.get('timezone'),
                    event.get('importance_score', 0),
                    event.get('description'),
                    event.get('expected_impact'),
                    event.get('country', 'cn'),
                    event.get('source_url')
                ))
                saved_count += 1
            except Exception as e:
                logger.debug(f"保存事件失败: {e}, 事件: {event.get('event_name') or event.get('name', 'unknown')}")
                continue

        self.conn.commit()
        return saved_count
    
    def get_keyword_mappings(self, keyword: str) -> List[Dict[str, Any]]:
        """获取关键词的板块映射"""
        cursor = self.conn.execute("""
            SELECT * FROM keyword_mappings 
            WHERE keyword = ?
            ORDER BY weight DESC
        """, (keyword,))
        
        return [dict(row) for row in cursor.fetchall()]
    
    def save_sector_stocks(self, sector_code: str, stocks: List[Dict[str, Any]]) -> int:
        """保存板块成分股"""
        saved_count = 0
        for stock in stocks:
            try:
                self.conn.execute("""
                    INSERT OR REPLACE INTO sector_stocks
                    (sector_code, sector_name, stock_code, stock_name, weight, is_leader)
                    VALUES (?, ?, ?, ?, ?, ?)
                """, (
                    sector_code,
                    stock.get('sector_name', ''),
                    stock.get('code', ''),
                    stock.get('name', ''),
                    stock.get('weight', 1.0),
                    stock.get('is_leader', False)
                ))
                saved_count += 1
            except Exception as e:
                logger.warning(f"保存成分股失败: {e}")
                continue
        
        self.conn.commit()
        return saved_count
    
    def get_sector_stocks(self, sector_code: str, leaders_only: bool = False) -> List[Dict[str, Any]]:
        """获取板块成分股"""
        query = """
            SELECT * FROM sector_stocks 
            WHERE sector_code = ?
        """
        if leaders_only:
            query += " AND is_leader = 1"
        
        query += " ORDER BY weight DESC"
        
        cursor = self.conn.execute(query, (sector_code,))
        return [dict(row) for row in cursor.fetchall()]
    
    def cleanup_old_news(self, days: int = 30):
        """清理旧的舆情数据"""
        cutoff_date = (datetime.now() - timedelta(days=days)).strftime('%Y-%m-%d %H:%M:%S')
        
        cursor = self.conn.execute("""
            DELETE FROM sentiment_news 
            WHERE published_at < ? 
            AND importance_score < 70
        """, (cutoff_date,))
        
        deleted_count = cursor.rowcount
        self.conn.commit()
        
        if deleted_count > 0:
            logger.info(f"清理了 {deleted_count} 条旧舆情数据")
        
        return deleted_count
    
    def get_statistics(self) -> Dict[str, Any]:
        """获取数据库统计信息"""
        stats = {}
        
        # 舆情统计
        cursor = self.conn.execute("""
            SELECT 
                COUNT(*) as total,
                COUNT(CASE WHEN importance_score >= 80 THEN 1 END) as high_importance,
                COUNT(CASE WHEN country = 'cn' THEN 1 END) as china_count,
                COUNT(CASE WHEN country = 'us' THEN 1 END) as us_count
            FROM sentiment_news
        """)
        row = cursor.fetchone()
        stats['news'] = dict(row) if row else {}
        
        # 事件统计
        cursor = self.conn.execute("""
            SELECT COUNT(*) as total FROM event_calendar
            WHERE event_date >= date('now')
        """)
        row = cursor.fetchone()
        stats['upcoming_events'] = row[0] if row else 0
        
        # 关键词映射统计
        cursor = self.conn.execute("SELECT COUNT(*) as total FROM keyword_mappings")
        row = cursor.fetchone()
        stats['keyword_mappings'] = row[0] if row else 0
        
        # 板块成分股统计
        cursor = self.conn.execute("SELECT COUNT(DISTINCT sector_code) as sectors FROM sector_stocks")
        row = cursor.fetchone()
        stats['sectors_count'] = row[0] if row else 0
        
        return stats
    
    def close(self):
        """关闭数据库连接"""
        if self.conn:
            self.conn.close()
            logger.info("舆情数据库连接已关闭")


# 全局实例
_sentiment_db = None


def get_sentiment_db() -> SentimentDB:
    """获取舆情数据库全局实例"""
    global _sentiment_db
    if _sentiment_db is None:
        _sentiment_db = SentimentDB()
    return _sentiment_db