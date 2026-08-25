"""
舆情影响预测分析器

提供：
- 基于历史数据的事件影响预测
- 正面/负面影响概率计算
- 置信度评估
- 风险场景分析
"""

import sqlite3
import json
import random
from typing import List, Dict, Any, Optional, Tuple
from datetime import datetime, timedelta
from loguru import logger
from dataclasses import dataclass


@dataclass
class ImpactPrediction:
    """影响预测结果"""
    sector_name: str              # 板块名称
    positive_probability: float   # 正面影响概率 (0-1)
    negative_probability: float   # 负面影响概率 (0-1)
    neutral_probability: float    # 中性影响概率 (0-1)
    expected_value: float         # 期望收益 (%)
    confidence: str               # 置信度 (high/medium/low)
    reasoning: str                # 分析理由
    risk_scenarios: List[Dict[str, Any]]  # 风险场景
    recommendation: str          # 操作建议


class ImpactAnalyzer:
    """舆情影响预测分析器"""
    
    def __init__(self, db_path: Optional[str] = None):
        """
        初始化分析器
        
        Args:
            db_path: 历史影响数据库路径
        """
        self.db_path = db_path
        self.conn = None
        self._connect()
    
    def _connect(self):
        """连接到历史影响数据库"""
        if self.db_path is None:
            from storage import storage
            self.db_path = storage.data_dir / "sentiment.db"
        
        try:
            self.conn = sqlite3.connect(
                str(self.db_path),
                timeout=10.0,
                check_same_thread=False,  # 允许asyncio.to_thread工作线程访问
            )
            self.conn.row_factory = sqlite3.Row
            logger.info("影响分析器连接成功")
        except Exception as e:
            logger.error(f"影响分析器连接失败: {e}")
            # 不抛出异常，允许在没有历史数据时运行
            self.conn = None
    
    def predict_impact(
        self, 
        event_type: str, 
        event_description: str,
        sectors: List[str],
        market_context: Optional[Dict[str, Any]] = None
    ) -> List[ImpactPrediction]:
        """
        预测事件对板块的影响
        
        Args:
            event_type: 事件类型 (macro/policy/earnings/sector/market)
            event_description: 事件描述
            sectors: 相关板块列表
            market_context: 当前市场环境
            
        Returns:
            板块影响预测列表
        """
        predictions = []
        
        for sector in sectors:
            # 查询历史数据
            historical_data = self._get_historical_impact(event_type, sector)
            
            if historical_data and len(historical_data) >= 3:
                # 基于历史数据的预测
                prediction = self._predict_from_history(
                    event_type, sector, historical_data, market_context
                )
            else:
                # 基于逻辑的预测（历史数据不足）
                prediction = self._predict_from_logic(
                    event_type, event_description, sector
                )
            
            predictions.append(prediction)
        
        return predictions
    
    def _get_historical_impact(self, event_type: str, sector: str) -> List[Dict[str, Any]]:
        """获取历史影响数据"""
        if not self.conn:
            return []
        
        try:
            cursor = self.conn.execute("""
                SELECT * FROM impact_history 
                WHERE sector_code = ?
                ORDER BY event_date DESC
                LIMIT 20
            """, (sector,))
            
            rows = cursor.fetchall()
            return [dict(row) for row in rows]
        
        except Exception as e:
            logger.warning(f"获取历史影响数据失败: {e}")
            return []
    
    def _predict_from_history(
        self,
        event_type: str,
        sector: str,
        historical_data: List[Dict[str, Any]],
        market_context: Optional[Dict[str, Any]]
    ) -> ImpactPrediction:
        """基于历史数据预测"""
        # 统计历史表现
        positive_count = sum(1 for h in historical_data if h.get('avg_change', 0) > 0)
        total_count = len(historical_data)
        
        # 基础概率
        base_positive_prob = positive_count / total_count if total_count > 0 else 0.5
        
        # 计算平均涨跌
        positive_changes = [h['avg_change'] for h in historical_data if h.get('avg_change', 0) > 0]
        negative_changes = [h['avg_change'] for h in historical_data if h.get('avg_change', 0) < 0]
        
        avg_positive_gain = sum(positive_changes) / len(positive_changes) if positive_changes else 0
        avg_negative_loss = sum(negative_changes) / len(negative_changes) if negative_changes else 0
        
        # 环境修正
        environment_modifier = self._calculate_environment_modifier(
            historical_data, market_context
        )
        
        # 修正后的概率
        modified_positive_prob = min(base_positive_prob * environment_modifier, 0.95)
        modified_negative_prob = max(1 - modified_positive_prob - 0.1, 0.05)
        neutral_prob = 1 - modified_positive_prob - modified_negative_prob
        
        # 期望收益
        expected_value = (
            modified_positive_prob * avg_positive_gain + 
            modified_negative_prob * avg_negative_loss
        )
        
        # 置信度评估
        confidence = self._assess_confidence(historical_data)
        
        # 风险场景
        risk_scenarios = self._identify_risk_scenarios(historical_data)
        
        # 推荐建议
        recommendation = self._generate_recommendation(
            modified_positive_prob, expected_value, confidence
        )
        
        return ImpactPrediction(
            sector_name=sector,
            positive_probability=round(modified_positive_prob, 2),
            negative_probability=round(modified_negative_prob, 2),
            neutral_probability=round(neutral_prob, 2),
            expected_value=round(expected_value, 2),
            confidence=confidence,
            reasoning=f"基于{total_count}次历史样本，正面概率{base_positive_prob:.1%}",
            risk_scenarios=risk_scenarios,
            recommendation=recommendation
        )
    
    def _predict_from_logic(
        self,
        event_type: str,
        event_description: str,
        sector: str
    ) -> ImpactPrediction:
        """基于逻辑预测（历史数据不足时）"""
        # 简单的逻辑规则
        logic_rules = {
            ('macro', '黄金'): {'positive': 0.7, 'negative': 0.2, 'expected': 2.5},
            ('macro', '银行'): {'positive': 0.3, 'negative': 0.6, 'expected': -1.5},
            ('policy', '地产'): {'positive': 0.8, 'negative': 0.1, 'expected': 3.0},
            ('earnings', '科技'): {'positive': 0.5, 'negative': 0.4, 'expected': 0.5},
        }
        
        key = (event_type, sector)
        if key in logic_rules:
            rule = logic_rules[key]
            return ImpactPrediction(
                sector_name=sector,
                positive_probability=rule['positive'],
                negative_probability=rule['negative'],
                neutral_probability=1 - rule['positive'] - rule['negative'],
                expected_value=rule['expected'],
                confidence='low',
                reasoning='基于经济学逻辑推导（无历史数据）',
                risk_scenarios=[
                    {
                        'scenario': '逻辑可能失效',
                        'probability': 0.3,
                        'impact': '市场环境变化导致规律失效'
                    }
                ],
                recommendation='建议小仓位试探，设置严格止损'
            )
        
        # 默认预测
        return ImpactPrediction(
            sector_name=sector,
            positive_probability=0.5,
            negative_probability=0.3,
            neutral_probability=0.2,
            expected_value=0.5,
            confidence='low',
            reasoning='缺乏历史数据，基于中性假设',
            risk_scenarios=[],
            recommendation='建议观望，等待更多数据'
        )
    
    def _calculate_environment_modifier(
        self,
        historical_data: List[Dict[str, Any]],
        market_context: Optional[Dict[str, Any]]
    ) -> float:
        """计算环境修正系数"""
        if not market_context:
            return 1.0
        
        modifier = 1.0
        
        # 趋势环境修正
        trend = market_context.get('trend', 'neutral')
        if trend == 'bull':
            modifier *= 1.1  # 牛市放大利好
        elif trend == 'bear':
            modifier *= 0.9  # 熊市缩小影响
        
        # 估值环境修正
        valuation = market_context.get('valuation', 'fair')
        if valuation == 'low':
            modifier *= 1.15  # 低估值更敏感
        elif valuation == 'high':
            modifier *= 0.85
        
        # 位置环境修正
        position = market_context.get('position', 'middle')
        if position == 'low':
            modifier *= 1.1  # 低位利好更有效
        elif position == 'high':
            modifier *= 0.9  # 高位可能利好出尽
        
        return max(min(modifier, 1.3), 0.7)  # 限制在0.7-1.3范围
    
    def _assess_confidence(self, historical_data: List[Dict[str, Any]]) -> str:
        """评估预测置信度"""
        total_samples = len(historical_data)
        
        # 样本数量评估
        if total_samples >= 8:
            sample_score = 3
        elif total_samples >= 5:
            sample_score = 2
        else:
            sample_score = 1
        
        # 胜率一致性评估
        positive_count = sum(1 for h in historical_data if h.get('avg_change', 0) > 0)
        win_rate = positive_count / total_samples if total_samples > 0 else 0.5
        
        if win_rate >= 0.75 or win_rate <= 0.25:
            consistency_score = 3
        elif win_rate >= 0.6 or win_rate <= 0.4:
            consistency_score = 2
        else:
            consistency_score = 1
        
        # 综合评分
        total_score = sample_score + consistency_score
        
        if total_score >= 5:
            return 'high'
        elif total_score >= 3:
            return 'medium'
        else:
            return 'low'
    
    def _identify_risk_scenarios(self, historical_data: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """识别风险场景"""
        scenarios = []
        
        # 找出历史负面样本
        negative_samples = [
            h for h in historical_data 
            if h.get('avg_change', 0) < 0
        ]
        
        if negative_samples:
            # 分析负面样本特征
            negative_contexts = []
            for sample in negative_samples:
                try:
                    context = json.loads(sample.get('market_context', '{}'))
                    negative_contexts.append(context)
                except:
                    continue
            
            # 提取共同特征
            if negative_contexts:
                high_position_count = sum(
                    1 for ctx in negative_contexts 
                    if ctx.get('position') == 'high'
                )
                
                if high_position_count >= len(negative_contexts) * 0.6:
                    scenarios.append({
                        'scenario': '高位利好出尽',
                        'probability': round(len(negative_samples) / len(historical_data), 2),
                        'impact': '当前高位环境下，利好可能已提前消化，公布后获利了结',
                        'mitigation': '若高开低走，建议止损'
                    })
        
        return scenarios
    
    def _generate_recommendation(
        self,
        positive_probability: float,
        expected_value: float,
        confidence: str
    ) -> str:
        """生成操作建议"""
        if positive_probability >= 0.75 and expected_value >= 2.0:
            return '强烈利好，建议关注龙头股'
        elif positive_probability >= 0.6:
            return '偏好利好，可适当配置'
        elif positive_probability >= 0.4:
            return '中性偏好，观望为主'
        elif positive_probability >= 0.25:
            return '偏利空，建议规避或减仓'
        else:
            return '明显利空，建议回避'
    
    def analyze_sector_impact(
        self,
        event: Dict[str, Any],
        sector_name: str
    ) -> Dict[str, Any]:
        """
        分析单个事件对单个板块的影响
        
        Args:
            event: 事件信息
            sector_name: 板块名称
            
        Returns:
            影响分析结果
        """
        event_type = event.get('event_type', 'general')
        event_description = event.get('description', '')
        
        # 生成预测
        prediction = self.predict_impact(
            event_type, event_description, [sector_name]
        )
        
        if prediction:
            return {
                'sector': sector_name,
                'positive_probability': prediction[0].positive_probability,
                'negative_probability': prediction[0].negative_probability,
                'neutral_probability': prediction[0].neutral_probability,
                'expected_value': prediction[0].expected_value,
                'confidence': prediction[0].confidence,
                'reasoning': prediction[0].reasoning,
                'recommendation': prediction[0].recommendation,
                'risk_scenarios': prediction[0].risk_scenarios,
            }
        
        return None
    
    def close(self):
        """关闭数据库连接"""
        if self.conn:
            self.conn.close()
            logger.info("影响分析器连接已关闭")


# 全局实例
_impact_analyzer = None


def get_impact_analyzer() -> ImpactAnalyzer:
    """获取影响分析器全局实例"""
    global _impact_analyzer
    if _impact_analyzer is None:
        _impact_analyzer = ImpactAnalyzer()
    return _impact_analyzer