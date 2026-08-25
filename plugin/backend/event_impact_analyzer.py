"""
事件优先级分析模块

提供：
- 基于历史波动的影响度评分
- 环境修正因子计算
- 置信度评估
- 风险场景识别
"""

import sqlite3
import json
from typing import List, Dict, Any, Optional, Tuple
from datetime import datetime, timedelta
from loguru import logger
from dataclasses import dataclass


@dataclass
class EventImpactPrediction:
    """事件影响预测"""
    event_name: str
    sector_name: str
    positive_probability: float
    negative_probability: float
    neutral_probability: float
    expected_value: float
    confidence: str
    reasoning: str
    risk_scenarios: List[Dict[str, Any]]
    recommendation: str


class EventImpactAnalyzer:
    """事件影响分析器"""
    
    def __init__(self, db_path: Optional[str] = None):
        """
        初始化分析器
        
        Args:
            db_path: 历史影响数据库路径
        """
        if db_path is None:
            from storage import storage
            self.db_path = storage.data_dir / "sentiment.db"
        else:
            self.db_path = db_path
        
        self.conn = None
        self._connect()
    
    def _connect(self):
        """连接到历史影响数据库"""
        try:
            self.conn = sqlite3.connect(
                str(self.db_path),
                timeout=10.0,
                check_same_thread=False,  # 允许asyncio.to_thread工作线程访问
            )
            self.conn.row_factory = sqlite3.Row
        except Exception as e:
            logger.error(f"影响分析器连接失败: {e}")
    
    def calculate_event_impact_score(
        self, 
        event: Dict[str, Any],
        sector: str
    ) -> int:
        """
        计算事件对板块的影响度评分
        
        Args:
            event: 事件信息
            sector: 板块名称
        
        Returns:
            评分 (0-100)
        """
        score = 0
        
        # 1. 事件类型权重 (30分)
        event_type = event.get('event_type', '')
        event_weights = {
            'us_macro': 30,      # 美国宏观数据
            'cn_macro': 28,      # 国内宏观数据
            'us_monetary': 29,   # 美国货币政策
            'cn_monetary': 28,   # 国内货币政策
            'earnings': 18,      # 财报季
            'sector': 20,        # 行业事件
            'market_event': 15,  # 市场事件
        }
        score += event_weights.get(event_type, 15)
        
        # 2. 事件重要性基础分 (25分)
        base_importance = event.get('importance_score', 70)
        normalized_importance = min(base_importance, 100) / 100
        score += normalized_importance * 25
        
        # 3. 板块相关性 (25分)
        sector_relevance = self._calculate_sector_relevance(event, sector)
        score += sector_relevance * 25
        
        # 4. 时效性加成 (10分)
        days_until = event.get('days_until', 0)
        if days_until <= 1:
            score += 10
        elif days_until <= 3:
            score += 8
        elif days_until <= 7:
            score += 5
        elif days_until <= 14:
            score += 3
        
        # 5. 历史影响修正 (10分)
        historical_impact = self._get_historical_avg_impact(event_type, sector)
        score += historical_impact * 10
        
        return min(int(score), 100)
    
    def _calculate_sector_relevance(self, event: Dict[str, Any], sector: str) -> float:
        """计算事件与板块的相关度 (0-1)"""
        relevance = 0.0
        
        event_name = event.get('name', '')
        keywords = event.get('keywords', [])
        
        # 板块关键词映射
        sector_keywords = {
            '黄金': ['黄金', '贵金属', '避险', '美元'],
            '地产': ['房地产', '住房', '房价', '地产'],
            '银行': ['银行', '利率', '息差', '信贷'],
            '券商': ['券商', '证券', '交易', '成交量'],
            '半导体': ['芯片', '半导体', '科技', 'AI', '人工智能'],
            '医药': ['医药', '医疗', '疫苗', '集采', '医保'],
            '新能源': ['光伏', '风电', '新能源', '电池', '储能'],
            '消费': ['消费', '零售', '白酒', '食品', '餐饮'],
            '军工': ['军工', '导弹', '卫星', '国防'],
        }
        
        if sector in sector_keywords:
            sector_words = sector_keywords[sector]
            # 检查事件关键词是否包含板块词汇
            matched_words = sum(1 for kw in keywords if kw in event_name or any(sw in event_name for sw in sector_words))
            relevance = min(matched_words / len(keywords) if keywords else 0, 1.0)
        
        return max(relevance, 0.1)  # 至少0.1的基础相关度
    
    def _get_historical_avg_impact(self, event_type: str, sector: str) -> float:
        """获取历史平均影响"""
        if not self.conn:
            return 0.5  # 无历史数据时返回中等值
        
        try:
            cursor = self.conn.execute("""
                SELECT AVG(avg_change) as avg_impact
                FROM impact_history
                WHERE sector_code = ?
                AND sample_count >= 3
            """, (sector,))
            
            result = cursor.fetchone()
            if result and result['avg_impact']:
                # 将涨跌幅转换为0-1的分数
                impact = abs(result['avg_impact'])
                return min(impact / 3.0, 1.0)  # 假设3%涨幅为满分
        
        except Exception as e:
            logger.debug(f"获取历史影响失败: {e}")
        
        return 0.5
    
    def predict_sector_impact(
        self, 
        event: Dict[str, Any],
        sectors: List[str],
        market_context: Optional[Dict[str, Any]] = None
    ) -> List[Dict[str, Any]]:
        """
        预测事件对多个板块的影响
        
        Args:
            event: 事件信息
            sectors: 板块列表
            market_context: 市场环境
        
        Returns:
            板块影响预测列表
        """
        predictions = []
        
        for sector in sectors:
            # 计算影响度评分
            impact_score = self.calculate_event_impact_score(event, sector)
            
            # 基于评分判断影响方向
            if impact_score >= 70:
                impact_direction = "positive"
                positive_prob = 0.75
            elif impact_score >= 40:
                impact_direction = "neutral"
                positive_prob = 0.50
            else:
                impact_direction = "negative"
                positive_prob = 0.25
            
            # 期望收益
            expected_value = (positive_prob - 0.5) * 3.0  # 假设最大波动3%
            
            # 置信度
            confidence = "medium"
            if impact_score >= 80:
                confidence = "high"
            elif impact_score >= 50:
                confidence = "medium"
            else:
                confidence = "low"
            
            # 推荐建议
            recommendation = self._generate_recommendation(positive_prob, expected_value, confidence)
            
            predictions.append({
                'sector': sector,
                'impact_score': impact_score,
                'impact_direction': impact_direction,
                'positive_probability': positive_prob,
                'negative_probability': 1 - positive_prob - 0.25,
                'neutral_probability': 0.25,
                'expected_value': expected_value,
                'confidence': confidence,
                'reasoning': f"基于事件类型和板块相关性，影响度{impact_score}分",
                'recommendation': recommendation,
            })
        
        # 按影响度排序
        predictions.sort(key=lambda x: x['impact_score'], reverse=True)
        
        return predictions
    
    def _generate_recommendation(self, positive_prob: float, expected_value: float, confidence: str) -> str:
        """生成操作建议"""
        if positive_prob >= 0.75:
            if expected_value >= 2.0:
                return "强烈利好，建议关注龙头股"
            else:
                return "利好，可适当配置"
        elif positive_prob >= 0.50:
            return "中性偏好，建议观望"
        elif positive_prob >= 0.25:
            return "偏利空，建议规避或减仓"
        else:
            return "明显利空，建议回避"
    
    def analyze_event_impact_for_sentiment(
        self, 
        sentiment_news: Dict[str, Any],
        market_context: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        为舆情新闻分析影响
        
        Args:
            sentiment_news: 舆情新闻
            market_context: 市场环境
        
        Returns:
            影响分析结果
        """
        # 将舆情转换为事件格式
        event = {
            'name': sentiment_news.get('title', ''),
            'event_type': sentiment_news.get('event_type', 'general'),
            'importance_score': sentiment_news.get('importance_score', 70),
            'keywords': sentiment_news.get('keywords', []),
            'country': sentiment_news.get('country', 'cn'),
        }
        
        # 识别相关板块
        related_sectors = []
        for sector_info in sentiment_news.get('related_sectors', []):
            related_sectors.append(sector_info['sector_name'])
        
        # 如果没有明确的相关板块，根据关键词推断
        if not related_sectors:
            related_sectors = self._infer_sectors_from_keywords(event['keywords'])
        
        # 分析影响
        predictions = self.predict_sector_impact(event, related_sectors, market_context)
        
        return {
            'sentiment_title': sentiment_news.get('title', ''),
            'sentiment_importance': sentiment_news.get('importance_score', 0),
            'related_sectors': related_sectors,
            'impact_predictions': predictions,
        }
    
    def _infer_sectors_from_keywords(self, keywords: List[str]) -> List[str]:
        """从关键词推断相关板块"""
        sectors = []
        
        keyword_sector_map = {
            '黄金': '黄金',
            '美联储': '黄金',
            'CPI': '消费',
            'PMI': '机械',
            '芯片': '半导体',
            '医药': '医药',
            '光伏': '新能源',
            '白酒': '消费',
        }
        
        for keyword in keywords:
            if keyword in keyword_sector_map:
                sector = keyword_sector_map[keyword]
                if sector not in sectors:
                    sectors.append(sector)
        
        return sectors
    
    def close(self):
        """关闭连接"""
        if self.conn:
            self.conn.close()


# 全局实例
_event_impact_analyzer = None


def get_event_impact_analyzer() -> EventImpactAnalyzer:
    """获取事件影响分析器全局实例"""
    global _event_impact_analyzer
    if _event_impact_analyzer is None:
        _event_impact_analyzer = EventImpactAnalyzer()
    return _event_impact_analyzer