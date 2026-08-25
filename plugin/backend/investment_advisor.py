"""
投资建议生成模块

提供：
- 基于舆情和个股生成投资提示
- 提示分级和模板生成
- 操作建议和风险提示
"""

from typing import List, Dict, Any, Optional
from datetime import datetime
from loguru import logger


class InvestmentAdvisor:
    """投资建议生成器"""
    
    def __init__(self):
        """初始化投资建议生成器"""
        self.tip_templates = {
            'positive_major': [
                "🔥 {stock} 重大利好！{reason}\n\n💡 操作建议：考虑逢低布局，关注突破信号\n⚠️ 风险提示：利好落地可能引发短期回调",
                "⚡ {stock} 利好催化！{reason}\n\n💡 操作建议：可适当加仓，设好止盈位\n⚠️ 风险提示：注意市场情绪变化",
            ],
            'positive_moderate': [
                "💡 {stock} 正面影响：{reason}\n\n💡 操作建议：可继续持有，关注持续性\n⚠️ 风险提示：关注后续验证",
            ],
            'negative_major': [
                "🔥 {stock} 重大利空！{reason}\n\n💡 操作建议：考虑减仓或规避，等待情绪修复\n⚠️ 风险提示：可能引发持续抛压",
                "⚡ {stock} 利空冲击！{reason}\n\n💡 操作建议：严格控制仓位，设好止损\n⚠️ 风险提示：关注是否过度反应",
            ],
            'negative_moderate': [
                "💡 {stock} 负面影响：{reason}\n\n💡 操作建议：谨慎持有，密切关注\n⚠️ 风险提示：评估影响程度",
            ],
            'neutral': [
                "📊 {stock} 中性影响：{reason}\n\n💡 操作建议：按原计划执行，保持观望\n⚠️ 风险提示：注意市场整体情绪",
            ],
        }
    
    def generate_investment_tip(
        self, 
        sentiment_news: Dict[str, Any],
        related_stocks: List[Dict[str, Any]],
        impact_predictions: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """生成投资建议"""
        
        if not related_stocks:
            return {
                'has_advice': False,
                'reason': '未找到相关个股'
            }
        
        # 分析整体影响
        overall_impact = self._analyze_overall_impact(sentiment_news, impact_predictions)
        
        # 为每只股票生成建议
        stock_tips = []
        for stock in related_stocks[:5]:  # 限制最多5只股票
            tip = self._generate_stock_tip(stock, overall_impact, sentiment_news)
            if tip:
                stock_tips.append(tip)
        
        return {
            'has_advice': len(stock_tips) > 0,
            'overall_impact': overall_impact,
            'stock_tips': stock_tips,
            'generated_at': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        }
    
    def _analyze_overall_impact(
        self, 
        sentiment_news: Dict[str, Any], 
        impact_predictions: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """分析整体影响"""
        
        # 基于舆情标签判断影响方向
        sentiment_tag = sentiment_news.get('sentiment_tag', 'neutral')
        importance_score = sentiment_news.get('importance_score', 60)
        
        impact_direction = 'neutral'
        impact_level = 'moderate'
        
        if sentiment_tag == 'positive':
            impact_direction = 'positive'
        elif sentiment_tag == 'negative':
            impact_direction = 'negative'
        
        # 根据重要性确定影响级别
        if importance_score >= 90:
            impact_level = 'major'
        elif importance_score >= 75:
            impact_level = 'moderate'
        else:
            impact_level = 'minor'
        
        return {
            'direction': impact_direction,
            'level': impact_level,
            'confidence': self._calculate_confidence(sentiment_news, impact_predictions)
        }
    
    def _calculate_confidence(
        self, 
        sentiment_news: Dict[str, Any], 
        impact_predictions: List[Dict[str, Any]]
    ) -> str:
        """计算置信度"""
        importance_score = sentiment_news.get('importance_score', 60)
        
        if importance_score >= 85 and len(impact_predictions) > 0:
            return 'high'
        elif importance_score >= 70:
            return 'medium'
        else:
            return 'low'
    
    def _generate_stock_tip(
        self, 
        stock: Dict[str, Any], 
        overall_impact: Dict[str, Any],
        sentiment_news: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """为单只股票生成建议"""
        
        direction = overall_impact['direction']
        level = overall_impact['level']
        
        # 选择模板
        template_key = f"{direction}_{level}"
        if template_key not in self.tip_templates:
            template_key = f"{direction}_moderate"
        if template_key not in self.tip_templates:
            template_key = "neutral"
        
        templates = self.tip_templates[template_key]
        template = templates[0] if templates else self.tip_templates['neutral'][0]
        
        # 生成理由
        reason = self._generate_reason(stock, sentiment_news)
        
        # 填充模板
        tip_text = template.format(
            stock=stock.get('stock_name', stock.get('stock_code', '')),
            reason=reason
        )
        
        return {
            'stock_code': stock.get('stock_code'),
            'stock_name': stock.get('stock_name'),
            'tip_text': tip_text,
            'impact_direction': direction,
            'impact_level': level,
            'action_suggestion': self._get_action_suggestion(direction, level)
        }
    
    def _generate_reason(self, stock: Dict[str, Any], sentiment_news: Dict[str, Any]) -> str:
        """生成影响理由"""
        title = sentiment_news.get('title', '')
        content = sentiment_news.get('content', '')
        
        # 提取关键信息
        if stock.get('match_type') == 'direct_name':
            return f"新闻直接提及{stock['stock_name']}：{title[:50]}..."
        elif stock.get('relation_type') == 'industry_chain':
            return f"产业链关联：{title[:50]}..."
        else:
            return f"相关板块影响：{title[:50]}..."
    
    def _get_action_suggestion(self, direction: str, level: str) -> str:
        """获取操作建议"""
        if direction == 'positive' and level == 'major':
            return 'consider_buying'
        elif direction == 'positive' and level == 'moderate':
            return 'hold_or_add'
        elif direction == 'negative' and level == 'major':
            return 'consider_selling'
        elif direction == 'negative' and level == 'moderate':
            return 'reduce_or_watch'
        else:
            return 'hold_and_watch'


def get_investment_advisor() -> InvestmentAdvisor:
    """获取投资建议生成器实例"""
    return InvestmentAdvisor()
