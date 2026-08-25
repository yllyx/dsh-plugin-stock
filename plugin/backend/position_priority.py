"""
持仓优先关联模块

提供：
- 持仓股自动识别
- 持仓相关舆情优先推送
- 持仓组合风险评估
- 持仓影响可视化
"""

import json
from typing import List, Dict, Any, Optional, Set
from datetime import datetime
from loguru import logger


class PositionPriority:
    """持仓优先关联引擎"""
    
    def __init__(self):
        """初始化持仓优先关联器"""
        # 用户持仓数据（实际应从持仓管理模块获取）
        self.user_positions = {}
        
        # 持仓相关舆情缓存
        self.position_sentiments = {}
    
    def update_positions(self, positions: List[Dict[str, Any]]):
        """更新用户持仓数据"""
        for position in positions:
            stock_code = position.get('code')
            if stock_code:
                self.user_positions[stock_code] = {
                    'name': position.get('name', ''),
                    'quantity': position.get('quantity', 0),
                    'cost': position.get('cost', 0),
                    'current_price': position.get('current_price', 0),
                    'market_value': position.get('market_value', 0),
                    'profit_loss': position.get('profit_loss', 0),
                    'profit_loss_pct': position.get('profit_loss_pct', 0)
                }
        
        logger.info(f"更新持仓数据，共 {len(self.user_positions)} 只股票")
    
    def identify_position_relevance(self, sentiment_news: Dict[str, Any]) -> Dict[str, Any]:
        """识别舆情与持仓的关联性"""
        
        if not self.user_positions:
            return {
                'has_position_relevance': False,
                'related_positions': []
            }
        
        related_positions = []
        sentiment_title = sentiment_news.get('title', '')
        sentiment_content = sentiment_news.get('content', '')
        sentiment_text = f"{sentiment_title} {sentiment_content}".lower()
        
        # 检查是否直接提及持仓股票
        for stock_code, position_info in self.user_positions.items():
            stock_name = position_info.get('name', '').lower()
            stock_code_lower = stock_code.lower()
            
            # 检查股票名称或代码是否在舆情文本中
            if stock_name in sentiment_text or stock_code_lower in sentiment_text:
                relevance_score = self._calculate_relevance_score(
                    sentiment_news, position_info, 'direct_mention'
                )
                related_positions.append({
                    'stock_code': stock_code,
                    'stock_name': position_info.get('name'),
                    'relevance_type': 'direct_mention',
                    'relevance_score': relevance_score,
                    'position_value': position_info.get('market_value', 0),
                    'profit_loss_pct': position_info.get('profit_loss_pct', 0)
                })
        
        # 检查板块关联
        if 'related_stocks' in sentiment_news:
            for stock in sentiment_news['related_stocks']:
                stock_code = stock.get('stock_code')
                if stock_code in self.user_positions:
                    relevance_score = self._calculate_relevance_score(
                        sentiment_news, self.user_positions[stock_code], 'sector_relation'
                    )
                    # 避免重复添加
                    if not any(p['stock_code'] == stock_code for p in related_positions):
                        related_positions.append({
                            'stock_code': stock_code,
                            'stock_name': self.user_positions[stock_code].get('name'),
                            'relevance_type': 'sector_relation',
                            'relevance_score': relevance_score,
                            'position_value': self.user_positions[stock_code].get('market_value', 0),
                            'profit_loss_pct': self.user_positions[stock_code].get('profit_loss_pct', 0)
                        })
        
        # 按相关度和持仓价值排序
        related_positions.sort(key=lambda x: (x['relevance_score'], x['position_value']), reverse=True)
        
        return {
            'has_position_relevance': len(related_positions) > 0,
            'related_positions': related_positions,
            'total_affected_value': sum(p['position_value'] for p in related_positions)
        }
    
    def _calculate_relevance_score(
        self, 
        sentiment_news: Dict[str, Any], 
        position_info: Dict[str, Any],
        relevance_type: str
    ) -> float:
        """计算关联度评分"""
        
        base_score = 0.0
        
        # 基础分数
        if relevance_type == 'direct_mention':
            base_score = 0.9  # 直接提及分数很高
        elif relevance_type == 'sector_relation':
            base_score = 0.6  # 板块关联分数中等
        
        # 考虑舆情重要性
        importance_score = sentiment_news.get('importance_score', 60) / 100
        adjusted_score = base_score * (0.7 + importance_score * 0.3)
        
        # 考虑持仓价值（持仓越大越重要）
        position_value = position_info.get('market_value', 0)
        value_factor = min(position_value / 100000, 1.0) * 0.1  # 最多增加10%
        
        final_score = min(adjusted_score + value_factor, 1.0)
        
        return round(final_score, 2)
    
    def calculate_portfolio_risk(
        self, 
        sentiment_news: Dict[str, Any],
        position_relevance: Dict[str, Any]
    ) -> Dict[str, Any]:
        """计算持仓组合风险"""
        
        if not position_relevance.get('has_position_relevance'):
            return {
                'has_portfolio_risk': False,
                'message': '无持仓关联风险'
            }
        
        related_positions = position_relevance['related_positions']
        sentiment_tag = sentiment_news.get('sentiment_tag', 'neutral')
        importance_score = sentiment_news.get('importance_score', 60)
        
        # 计算受影响的总市值
        total_affected_value = position_relevance['total_affected_value']
        
        # 计算风险级别
        risk_level = 'low'
        risk_score = 0
        
        if sentiment_tag == 'negative':
            # 负面舆情风险计算
            if importance_score >= 90:
                risk_score = 0.8
            elif importance_score >= 75:
                risk_score = 0.6
            else:
                risk_score = 0.4
        elif sentiment_tag == 'positive':
            # 正面舆情（可能是机会）
            risk_score = 0.1
        else:
            # 中性舆情
            risk_score = 0.2
        
        # 考虑受影响市值比例
        total_portfolio_value = sum(pos.get('market_value', 0) for pos in self.user_positions.values())
        if total_portfolio_value > 0:
            affected_ratio = total_affected_value / total_portfolio_value
            risk_score = risk_score * (0.5 + affected_ratio * 0.5)
        
        # 确定风险级别
        if risk_score >= 0.7:
            risk_level = 'high'
        elif risk_score >= 0.4:
            risk_level = 'medium'
        else:
            risk_level = 'low'
        
        return {
            'has_portfolio_risk': True,
            'risk_level': risk_level,
            'risk_score': round(risk_score, 2),
            'affected_positions': len(related_positions),
            'affected_value': total_affected_value,
            'affected_ratio': round(total_affected_value / total_portfolio_value * 100, 1) if total_portfolio_value > 0 else 0,
            'recommendations': self._generate_risk_recommendations(risk_level, sentiment_tag, related_positions)
        }
    
    def _generate_risk_recommendations(
        self, 
        risk_level: str, 
        sentiment_tag: str,
        affected_positions: List[Dict[str, Any]]
    ) -> List[str]:
        """生成风险建议"""
        
        recommendations = []
        
        if risk_level == 'high' and sentiment_tag == 'negative':
            recommendations.append("🔥 高风险！建议立即关注受影响持仓，考虑减仓或对冲")
            recommendations.append(f"受影响持仓: {', '.join([p['stock_name'] for p in affected_positions[:3]])}")
            
        elif risk_level == 'medium' and sentiment_tag == 'negative':
            recommendations.append("⚠️ 中等风险，建议密切监控受影响持仓表现")
            recommendations.append("考虑设置止损位，控制风险敞口")
            
        elif risk_level == 'high' and sentiment_tag == 'positive':
            recommendations.append("💡 重大机会！相关持仓可能受益，可考虑适当加仓")
            
        elif risk_level == 'medium' and sentiment_tag == 'positive':
            recommendations.append("📈 正面影响，相关持仓可能有表现机会")
        
        if not recommendations:
            recommendations.append("📊 风险可控，保持正常监控")
        
        return recommendations
    
    def prioritize_sentiments(self, sentiment_list: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """对舆情列表进行持仓优先排序"""
        
        # 为每个舆情添加持仓关联度
        for sentiment in sentiment_list:
            position_relevance = self.identify_position_relevance(sentiment)
            sentiment['position_relevance'] = position_relevance
            
            # 计算综合优先级分数
            importance_score = sentiment.get('importance_score', 60)
            position_bonus = 0
            
            if position_relevance.get('has_position_relevance'):
                # 持仓相关舆情加分
                affected_value = position_relevance['total_affected_value']
                position_bonus = min(affected_value / 50000 * 15, 20)  # 最多加20分
            
            sentiment['priority_score'] = importance_score + position_bonus
        
        # 按优先级分数排序
        prioritized_sentiments = sorted(
            sentiment_list, 
            key=lambda x: x.get('priority_score', 0), 
            reverse=True
        )
        
        return prioritized_sentiments


def get_position_priority() -> PositionPriority:
    """获取持仓优先关联器实例"""
    return PositionPriority()
