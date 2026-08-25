"""
影响预测模块

提供：
- 基于历史数据的概率计算模型
- 环境修正因子计算
- 正面/负面/中性概率预测
- 置信度评估
"""

import json
from typing import List, Dict, Any, Optional
from datetime import datetime
from loguru import logger
from impact_history import get_impact_history_db


class ImpactPredictor:
    """影响预测引擎"""
    
    def __init__(self):
        """初始化影响预测器"""
        self.impact_db = get_impact_history_db()
        
        # 环境修正因子配置
        self.environment_weights = {
            'trend': 0.3,        # 趋势权重
            'valuation': 0.25,   # 估值权重  
            'position': 0.2,      # 位置权重
            'funds': 0.15,        # 资金权重
            'sentiment': 0.1      # 情绪权重
        }
    
    def predict_sector_impact(
        self,
        event: Dict[str, Any],
        sector_name: str,
        current_market_context: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """预测事件对板块的影响"""
        
        # 获取历史统计数据
        event_name = event.get('name', '')
        event_type = event.get('event_type', 'general')
        
        historical_stats = self.impact_db.calculate_historical_stats(
            event_name, event_type, sector_name
        )
        
        if not historical_stats.get('has_history'):
            return {
                'sector_name': sector_name,
                'prediction_available': False,
                'message': '无历史数据支持'
            }
        
        # 计算基础概率
        base_probabilities = {
            'positive': historical_stats['positive_rate'] / 100,
            'negative': historical_stats['negative_rate'] / 100,
            'neutral': 1 - (historical_stats['positive_rate'] + historical_stats['negative_rate']) / 100
        }
        
        # 应用环境修正
        if current_market_context:
            adjusted_probabilities = self._apply_environment_correction(
                base_probabilities,
                historical_stats,
                current_market_context
            )
        else:
            adjusted_probabilities = base_probabilities
        
        # 计算期望收益和置信度
        expected_return = historical_stats['expected_return']
        confidence = historical_stats['confidence']
        
        # 生成预测结果
        prediction = {
            'sector_name': sector_name,
            'prediction_available': True,
            'historical_sample_count': historical_stats['sample_count'],
            'probabilities': {
                'positive': round(adjusted_probabilities['positive'] * 100, 1),
                'negative': round(adjusted_probabilities['negative'] * 100, 1),
                'neutral': round(adjusted_probabilities['neutral'] * 100, 1)
            },
            'expected_return': round(expected_return, 2),
            'confidence': confidence,
            'historical_performance': {
                'avg_positive_magnitude': historical_stats['avg_positive_magnitude'],
                'avg_negative_magnitude': historical_stats['avg_negative_magnitude']
            },
            'prediction_reasoning': self._generate_prediction_reasoning(
                historical_stats, adjusted_probabilities, confidence
            )
        }
        
        return prediction
    
    def _apply_environment_correction(
        self,
        base_probabilities: Dict[str, float],
        historical_stats: Dict[str, Any],
        current_context: Dict[str, Any]
    ) -> Dict[str, float]:
        """应用环境修正因子"""
        
        corrected = base_probabilities.copy()
        
        # 计算环境修正系数
        correction_factor = self._calculate_environment_correction(
            historical_stats, current_context
        )
        
        # 应用修正
        if correction_factor > 0:
            # 环境利好，增加正面概率
            correction_amount = min(correction_factor * 0.15, 0.2)  # 最多增加20%
            corrected['positive'] = min(corrected['positive'] + correction_amount, 0.9)
            corrected['negative'] = max(corrected['negative'] - correction_amount / 2, 0.05)
            corrected['neutral'] = 1 - corrected['positive'] - corrected['negative']
            
        elif correction_factor < 0:
            # 环境不利，增加负面概率
            correction_amount = min(abs(correction_factor) * 0.15, 0.2)
            corrected['negative'] = min(corrected['negative'] + correction_amount, 0.9)
            corrected['positive'] = max(corrected['positive'] - correction_amount / 2, 0.05)
            corrected['neutral'] = 1 - corrected['positive'] - corrected['negative']
        
        return corrected
    
    def _calculate_environment_correction(
        self,
        historical_stats: Dict[str, Any],
        current_context: Dict[str, Any]
    ) -> float:
        """计算环境修正系数"""
        
        correction_score = 0
        
        # 分析历史正面样本的环境条件
        positive_samples = [e for e in historical_stats.get('recent_events', []) 
                          if e.get('impact_direction') == 'positive']
        
        if not positive_samples:
            return 0
        
        # 计算当前环境与历史正面环境的相似度
        for factor, weight in self.environment_weights.items():
            current_value = current_context.get(factor)
            if not current_value:
                continue
                
            # 分析历史正面样本中该因子的常见值
            positive_factor_values = [e.get('market_context', {}).get(factor) 
                                    for e in positive_samples 
                                    if e.get('market_context', {}).get(factor)]
            
            if not positive_factor_values:
                continue
            
            # 计算当前值与正面环境的匹配度
            match_score = self._calculate_factor_match(current_value, positive_factor_values)
            correction_score += match_score * weight
        
        return round(correction_score, 2)
    
    def _calculate_factor_match(self, current_value: str, historical_values: List[str]) -> float:
        """计算单个因子的匹配度"""
        
        # 统计历史正面样本中各值的频率
        value_counts = {}
        for value in historical_values:
            value_counts[value] = value_counts.get(value, 0) + 1
        
        total_count = len(historical_values)
        
        # 计算当前值在历史正面样本中的占比
        current_match_count = value_counts.get(current_value, 0)
        match_rate = current_match_count / total_count if total_count > 0 else 0
        
        return match_rate
    
    def _generate_prediction_reasoning(
        self,
        historical_stats: Dict[str, Any],
        adjusted_probabilities: Dict[str, float],
        confidence: str
    ) -> str:
        """生成预测推理说明"""
        
        reasoning_parts = []
        
        # 样本数量说明
        sample_count = historical_stats['sample_count']
        reasoning_parts.append(f"基于{sample_count}个历史样本")
        
        # 历史表现说明
        positive_rate = historical_stats['positive_rate']
        negative_rate = historical_stats['negative_rate']
        
        if positive_rate > 60:
            reasoning_parts.append(f"历史上{positive_rate}%概率为正面影响")
        elif negative_rate > 60:
            reasoning_parts.append(f"历史上{negative_rate}%概率为负面影响")
        else:
            reasoning_parts.append("历史影响相对均衡")
        
        # 期望收益说明
        expected_return = historical_stats['expected_return']
        if expected_return > 0.5:
            reasoning_parts.append(f"历史平均正收益{expected_return:.1f}%")
        elif expected_return < -0.5:
            reasoning_parts.append(f"历史平均负收益{abs(expected_return):.1f}%")
        
        # 置信度说明
        confidence_map = {
            'high': '高',
            'medium': '中', 
            'low': '低'
        }
        reasoning_parts.append(f"预测置信度: {confidence_map.get(confidence, '中')}")
        
        return "；".join(reasoning_parts)
    
    def analyze_risk_scenarios(
        self,
        event: Dict[str, Any],
        sector_name: str
    ) -> Dict[str, Any]:
        """分析风险情景"""
        
        event_name = event.get('name', '')
        event_type = event.get('event_type', 'general')
        
        # 获取历史负面情景
        negative_scenarios = self.impact_db.get_negative_scenarios(
            event_name, event_type, sector_name
        )
        
        if not negative_scenarios:
            return {
                'has_risk_analysis': False,
                'message': '无历史负面样本'
            }
        
        # 分析负面情景的共性
        common_conditions = self._analyze_common_conditions(negative_scenarios)
        
        # 生成风险提示
        risk_warnings = []
        
        if common_conditions.get('downtrend_ratio', 0) > 0.6:
            risk_warnings.append("市场下跌趋势时负面影响加剧")
            
        if common_conditions.get('negative_sentiment_ratio', 0) > 0.7:
            risk_warnings.append("市场情绪悲观时容易引发超跌")
            
        if common_conditions.get('overvalued_ratio', 0) > 0.5:
            risk_warnings.append("估值过高时容易出现利好出尽")
        
        return {
            'has_risk_analysis': True,
            'negative_sample_count': len(negative_scenarios),
            'average_negative_magnitude': sum(s['impact_magnitude'] for s in negative_scenarios) / len(negative_scenarios),
            'common_conditions': common_conditions,
            'risk_warnings': risk_warnings,
            'mitigation_strategies': self._generate_mitigation_strategies(common_conditions)
        }
    
    def _analyze_common_conditions(self, scenarios: List[Dict[str, Any]]) -> Dict[str, Any]:
        """分析负面情景的共性条件"""
        
        if not scenarios:
            return {}
        
        # 统计各环境条件的出现频率
        downtrend_count = sum(1 for s in scenarios 
                            if s.get('market_context', {}).get('trend') == 'downtrend')
        negative_sentiment_count = sum(1 for s in scenarios 
                                      if s.get('market_context', {}).get('sentiment') == 'negative')
        overvalued_count = sum(1 for s in scenarios 
                               if s.get('market_context', {}).get('valuation') == 'overvalued')
        
        total_count = len(scenarios)
        
        return {
            'downtrend_ratio': downtrend_count / total_count if total_count > 0 else 0,
            'negative_sentiment_ratio': negative_sentiment_count / total_count if total_count > 0 else 0,
            'overvalued_ratio': overvalued_count / total_count if total_count > 0 else 0
        }
    
    def _generate_mitigation_strategies(self, common_conditions: Dict[str, float]) -> List[str]:
        """生成风险应对策略"""
        
        strategies = []
        
        if common_conditions.get('downtrend_ratio', 0) > 0.6:
            strategies.append("建议在市场下跌趋势中降低仓位或采取观望策略")
            
        if common_conditions.get('negative_sentiment_ratio', 0) > 0.7:
            strategies.append("关注市场情绪极端时的超跌反弹机会")
            
        if common_conditions.get('overvalued_ratio', 0) > 0.5:
            strategies.append("警惕估值过高时的利好出尽风险，考虑逢高减仓")
        
        if not strategies:
            strategies.append("保持正常风险管理，设置止损位")
        
        return strategies


def get_impact_predictor() -> ImpactPredictor:
    """获取影响预测器实例"""
    return ImpactPredictor()
