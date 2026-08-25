"""
历史影响数据库模块

提供：
- 历史事件影响数据收集和存储
- 事件相似度匹配算法
- 历史表现统计（胜率/平均涨跌）
- 样本环境标记（趋势/估值/位置）
"""

import sqlite3
import json
from typing import List, Dict, Any, Optional, Tuple
from datetime import datetime, timedelta
from loguru import logger
from pathlib import Path


class ImpactHistoryDB:
    """历史影响数据库管理类"""
    
    def __init__(self, db_path: Optional[str] = None):
        """初始化历史影响数据库"""
        if db_path is None:
            # 默认路径
            data_dir = Path.home() / ".dsh" / "stock-data"
            data_dir.mkdir(parents=True, exist_ok=True)
            db_path = data_dir / "sentiment_impact_history.db"
        
        self.db_path = db_path
        self._init_db()
        self._load_sample_data()
    
    def _init_db(self):
        """初始化数据库表结构"""
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS impact_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_name TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    event_date TEXT NOT NULL,
                    country TEXT NOT NULL,
                    sector_name TEXT NOT NULL,
                    impact_direction TEXT NOT NULL,
                    impact_magnitude REAL NOT NULL,
                    market_context TEXT,
                    sample_quality INTEGER DEFAULT 1,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(event_name, event_date, sector_name)
                )
            """)
            
            # 创建索引
            conn.execute("CREATE INDEX IF NOT EXISTS idx_event_name ON impact_history(event_name)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_event_type ON impact_history(event_type)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_sector ON impact_history(sector_name)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_date ON impact_history(event_date)")
            
            conn.commit()
    
    def _load_sample_data(self):
        """加载示例历史数据"""
        # 检查是否已有数据
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute("SELECT COUNT(*) FROM impact_history")
            count = cursor.fetchone()[0]
            
            if count > 0:
                logger.info(f"历史影响数据库已有 {count} 条记录")
                return
        
        # 加载示例数据（重要历史事件）
        sample_data = self._get_sample_historical_events()
        
        with sqlite3.connect(self.db_path) as conn:
            for record in sample_data:
                try:
                    conn.execute("""
                        INSERT OR REPLACE INTO impact_history 
                        (event_name, event_type, event_date, country, sector_name, 
                         impact_direction, impact_magnitude, market_context, sample_quality)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, (
                        record['event_name'],
                        record['event_type'], 
                        record['event_date'],
                        record['country'],
                        record['sector_name'],
                        record['impact_direction'],
                        record['impact_magnitude'],
                        json.dumps(record.get('market_context', {})),
                        record.get('sample_quality', 1)
                    ))
                except Exception as e:
                    logger.warning(f"插入样本数据失败: {e}")
            
            conn.commit()
            logger.info(f"加载了 {len(sample_data)} 条历史影响样本数据")
    
    def _get_sample_historical_events(self) -> List[Dict[str, Any]]:
        """获取示例历史事件数据"""
        # 这里模拟一些重要的历史事件影响数据
        # 实际应用中应该从真实数据源获取
        
        return [
            # 2024年美联储议息会议
            {
                'event_name': '美联储FOMC会议',
                'event_type': 'monetary_policy',
                'event_date': '2024-06-12',
                'country': 'us',
                'sector_name': '黄金',
                'impact_direction': 'positive',
                'impact_magnitude': 2.5,
                'market_context': {'trend': 'uptrend', 'sentiment': 'positive'},
                'sample_quality': 3
            },
            {
                'event_name': '美联储FOMC会议',
                'event_type': 'monetary_policy',
                'event_date': '2024-06-12',
                'country': 'us',
                'sector_name': '银行',
                'impact_direction': 'negative',
                'impact_magnitude': -1.8,
                'market_context': {'trend': 'uptrend', 'sentiment': 'positive'},
                'sample_quality': 3
            },
            
            # 2024年非农就业报告
            {
                'event_name': '非农就业报告',
                'event_type': 'economic_data',
                'event_date': '2024-06-07',
                'country': 'us',
                'sector_name': '消费',
                'impact_direction': 'positive',
                'impact_magnitude': 1.2,
                'market_context': {'trend': 'sideways', 'sentiment': 'neutral'},
                'sample_quality': 2
            },
            
            # 2024年CPI数据
            {
                'event_name': 'CPI数据',
                'event_type': 'economic_data',
                'event_date': '2024-06-12',
                'country': 'us',
                'sector_name': '消费',
                'impact_direction': 'negative',
                'impact_magnitude': -0.8,
                'market_context': {'trend': 'uptrend', 'sentiment': 'positive'},
                'sample_quality': 2
            },
            {
                'event_name': 'CPI数据',
                'event_type': 'economic_data',
                'event_date': '2024-06-12',
                'country': 'us',
                'sector_name': '黄金',
                'impact_direction': 'positive',
                'impact_magnitude': 1.5,
                'market_context': {'trend': 'uptrend', 'sentiment': 'positive'},
                'sample_quality': 2
            },
            
            # 2024年中国央行降准
            {
                'event_name': '央行降准',
                'event_type': 'monetary_policy',
                'event_date': '2024-03-27',
                'country': 'cn',
                'sector_name': '银行',
                'impact_direction': 'positive',
                'impact_magnitude': 1.8,
                'market_context': {'trend': 'downtrend', 'sentiment': 'negative'},
                'sample_quality': 3
            },
            {
                'event_name': '央行降准',
                'event_type': 'monetary_policy',
                'event_date': '2024-03-27',
                'country': 'cn',
                'sector_name': '地产',
                'impact_direction': 'positive',
                'impact_magnitude': 2.2,
                'market_context': {'trend': 'downtrend', 'sentiment': 'negative'},
                'sample_quality': 3
            },
            
            # 2024年PMI数据
            {
                'event_name': 'PMI数据',
                'event_type': 'economic_data',
                'event_date': '2024-05-31',
                'country': 'cn',
                'sector_name': '机械',
                'impact_direction': 'positive',
                'impact_magnitude': 0.9,
                'market_context': {'trend': 'sideways', 'sentiment': 'neutral'},
                'sample_quality': 2
            },
            
            # 更多历史事件样本...
            # 实际应用中应该包含2019年至今的所有重要事件
        ]
    
    def find_similar_events(
        self, 
        event_name: str, 
        event_type: str,
        sector_name: str,
        limit: int = 10
    ) -> List[Dict[str, Any]]:
        """查找相似的历史事件"""
        
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            
            # 构建查询 - 查找相同事件类型和板块的历史记录
            query = """
                SELECT * FROM impact_history 
                WHERE event_type = ? AND sector_name = ?
                ORDER BY event_date DESC, sample_quality DESC
                LIMIT ?
            """
            
            cursor = conn.execute(query, (event_type, sector_name, limit))
            rows = cursor.fetchall()
            
            results = []
            for row in rows:
                record = dict(row)
                # 解析市场环境JSON
                if record.get('market_context'):
                    try:
                        record['market_context'] = json.loads(record['market_context'])
                    except:
                        record['market_context'] = {}
                results.append(record)
            
            logger.debug(f"找到 {len(results)} 个相似历史事件")
            return results
    
    def calculate_historical_stats(
        self, 
        event_name: str, 
        event_type: str,
        sector_name: str
    ) -> Dict[str, Any]:
        """计算历史统计数据"""
        
        similar_events = self.find_similar_events(event_name, event_type, sector_name, limit=50)
        
        if not similar_events:
            return {
                'has_history': False,
                'sample_count': 0,
                'message': '无历史数据'
            }
        
        # 统计正面/负面/中性影响
        positive_count = sum(1 for e in similar_events if e['impact_direction'] == 'positive')
        negative_count = sum(1 for e in similar_events if e['impact_direction'] == 'negative')
        neutral_count = sum(1 for e in similar_events if e['impact_direction'] == 'neutral')
        
        total_count = len(similar_events)
        
        # 计算胜率
        positive_rate = positive_count / total_count if total_count > 0 else 0
        negative_rate = negative_count / total_count if total_count > 0 else 0
        
        # 计算平均影响幅度
        positive_magnitudes = [e['impact_magnitude'] for e in similar_events if e['impact_direction'] == 'positive']
        negative_magnitudes = [e['impact_magnitude'] for e in similar_events if e['impact_direction'] == 'negative']
        
        avg_positive_magnitude = sum(positive_magnitudes) / len(positive_magnitudes) if positive_magnitudes else 0
        avg_negative_magnitude = sum(negative_magnitudes) / len(negative_magnitudes) if negative_magnitudes else 0
        
        # 计算期望收益
        expected_return = (positive_rate * avg_positive_magnitude) - (negative_rate * abs(avg_negative_magnitude))
        
        return {
            'has_history': True,
            'sample_count': total_count,
            'positive_count': positive_count,
            'negative_count': negative_count,
            'neutral_count': neutral_count,
            'positive_rate': round(positive_rate * 100, 1),
            'negative_rate': round(negative_rate * 100, 1),
            'avg_positive_magnitude': round(avg_positive_magnitude, 2),
            'avg_negative_magnitude': round(avg_negative_magnitude, 2),
            'expected_return': round(expected_return, 2),
            'confidence': self._calculate_confidence(similar_events),
            'recent_events': similar_events[:5]  # 最近5个样本
        }
    
    def _calculate_confidence(self, samples: List[Dict[str, Any]]) -> str:
        """计算置信度"""
        sample_count = len(samples)
        high_quality_count = sum(1 for s in samples if s.get('sample_quality', 1) >= 3)
        
        if sample_count >= 10 and high_quality_count >= 5:
            return 'high'
        elif sample_count >= 5 and high_quality_count >= 2:
            return 'medium'
        else:
            return 'low'
    
    def get_negative_scenarios(
        self, 
        event_name: str, 
        event_type: str,
        sector_name: str
    ) -> List[Dict[str, Any]]:
        """获取历史负面情景"""
        
        similar_events = self.find_similar_events(event_name, event_type, sector_name, limit=50)
        
        # 筛选负面影响的样本
        negative_scenarios = [e for e in similar_events if e['impact_direction'] == 'negative']
        
        # 分析负面发生的特征
        scenarios = []
        for scenario in negative_scenarios:
            scenario_info = {
                'event_date': scenario['event_date'],
                'impact_magnitude': scenario['impact_magnitude'],
                'market_context': scenario.get('market_context', {}),
                'reasoning': self._generate_negative_reasoning(scenario)
            }
            scenarios.append(scenario_info)
        
        return scenarios
    
    def _generate_negative_reasoning(self, scenario: Dict[str, Any]) -> str:
        """生成负面情景的原因分析"""
        context = scenario.get('market_context', {})
        
        reasons = []
        
        if context.get('trend') == 'downtrend':
            reasons.append("市场处于下跌趋势")
        if context.get('sentiment') == 'negative':
            reasons.append("市场情绪悲观")
        if context.get('valuation') == 'overvalued':
            reasons.append("板块估值过高")
        
        if reasons:
            return "、".join(reasons)
        else:
            return "具体原因需进一步分析"
    
    def add_impact_record(
        self,
        event_name: str,
        event_type: str,
        event_date: str,
        country: str,
        sector_name: str,
        impact_direction: str,
        impact_magnitude: float,
        market_context: Optional[Dict[str, Any]] = None,
        sample_quality: int = 1
    ):
        """添加新的影响记录"""
        with sqlite3.connect(self.db_path) as conn:
            try:
                conn.execute("""
                    INSERT OR REPLACE INTO impact_history 
                    (event_name, event_type, event_date, country, sector_name, 
                     impact_direction, impact_magnitude, market_context, sample_quality)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    event_name,
                    event_type,
                    event_date,
                    country,
                    sector_name,
                    impact_direction,
                    impact_magnitude,
                    json.dumps(market_context or {}),
                    sample_quality
                ))
                conn.commit()
                logger.info(f"添加影响记录: {event_name} -> {sector_name} ({impact_direction})")
                return True
            except Exception as e:
                logger.error(f"添加影响记录失败: {e}")
                return False


def get_impact_history_db() -> ImpactHistoryDB:
    """获取历史影响数据库实例"""
    return ImpactHistoryDB()
