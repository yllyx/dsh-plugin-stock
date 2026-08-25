"""
板块映射和个股关联模块

提供：
- 舆情关键词到板块的映射
- 板块成分股提取
- 个股筛选和评分
- 投资提示生成
"""

import json
from typing import List, Dict, Any, Optional
from datetime import datetime
from loguru import logger


class SectorMapper:
    """板块映射引擎"""
    
    def __init__(self):
        """初始化板块映射"""
        self.sector_mappings = self._build_sector_mappings()
        self.stock_basics = {}  # 股票基本信息缓存
        self._load_sector_stocks()
    
    def _build_sector_mappings(self) -> Dict[str, List[Dict[str, Any]]]:
        """构建舆情关键词→板块映射"""
        return {
            # 利率/货币政策
            "降息": [
                {"sector": "地产", "impact": "positive", "weight": 0.9, "reasoning": "降低资金成本，利好地产"},
                {"sector": "银行", "impact": "negative", "weight": 0.7, "reasoning": "息差收窄"},
                {"sector": "券商", "impact": "positive", "weight": 0.8, "reasoning": "流动性改善"},
                {"sector": "黄金", "impact": "positive", "weight": 0.85, "reasoning": "美元走弱"},
            ],
            "加息": [
                {"sector": "银行", "impact": "positive", "weight": 0.8, "reasoning": "息差扩大"},
                {"sector": "地产", "impact": "negative", "weight": 0.9, "reasoning": "资金成本上升"},
            ],
            "美联储": [
                {"sector": "黄金", "impact": "neutral", "weight": 0.95, "reasoning": "货币政策影响"},
                {"sector": "有色金属", "impact": "neutral", "weight": 0.8, "reasoning": "美元相关性"},
            ],
            "FOMC": [
                {"sector": "黄金", "impact": "neutral", "weight": 0.95, "reasoning": "利率决议"},
            ],
            
            # 经济数据
            "CPI": [
                {"sector": "消费", "impact": "negative", "weight": 0.7, "reasoning": "通胀压制消费"},
                {"sector": "有色金属", "impact": "positive", "weight": 0.6, "reasoning": "通胀预期"},
            ],
            "PMI": [
                {"sector": "机械", "impact": "positive", "weight": 0.8, "reasoning": "制造业复苏"},
                {"sector": "电气", "impact": "positive", "weight": 0.7, "reasoning": "设备需求"},
            ],
            
            # 贸易/科技
            "芯片": [
                {"sector": "半导体", "impact": "positive", "weight": 0.95, "reasoning": "直接相关"},
            ],
            "关税": [
                {"sector": "出口链", "impact": "negative", "weight": 0.8, "reasoning": "出口受影响"},
            ],
            
            # 行业政策
            "集采": [
                {"sector": "医药", "impact": "negative", "weight": 0.85, "reasoning": "价格下降"},
            ],
            "光伏": [
                {"sector": "光伏", "impact": "positive", "weight": 0.9, "reasoning": "政策支持"},
            ],
        }
    
    def _load_sector_stocks(self):
        """加载板块成分股数据"""
        # 重要板块的龙头股（示例数据，实际应从数据库或API获取）
        self.sector_stocks = {
            "黄金": [
                {"code": "600547", "name": "山东黄金", "weight": 0.15, "is_leader": True},
                {"code": "601899", "name": "紫金矿业", "weight": 0.12, "is_leader": True},
                {"code": "600489", "name": "中金黄金", "weight": 0.08, "is_leader": False},
            ],
            "半导体": [
                {"code": "688981", "name": "中芯国际", "weight": 0.12, "is_leader": True},
                {"code": "002371", "name": "北方华创", "weight": 0.10, "is_leader": True},
                {"code": "688012", "name": "中微公司", "weight": 0.08, "is_leader": True},
                {"code": "300750", "name": "宁德时代", "weight": 0.15, "is_leader": True},
            ],
            "新能源": [
                {"code": "300750", "name": "宁德时代", "weight": 0.15, "is_leader": True},
                {"code": "002594", "name": "比亚迪", "weight": 0.12, "is_leader": True},
                {"code": "300274", "name": "阳光电源", "weight": 0.08, "is_leader": True},
            ],
            "消费": [
                {"code": "600519", "name": "贵州茅台", "weight": 0.20, "is_leader": True},
                {"code": "000858", "name": "五粮液", "weight": 0.12, "is_leader": True},
                {"code": "000568", "name": "泸州老窖", "weight": 0.08, "is_leader": True},
            ],
            "银行": [
                {"code": "600036", "name": "招商银行", "weight": 0.15, "is_leader": True},
                {"code": "601398", "name": "工商银行", "weight": 0.12, "is_leader": True},
                {"code": "601166", "name": "兴业银行", "weight": 0.10, "is_leader": True},
            ],
            "券商": [
                {"code": "600030", "name": "中信证券", "weight": 0.12, "is_leader": True},
                {"code": "601688", "name": "华泰证券", "weight": 0.10, "is_leader": True},
                {"code": "600999", "name": "招商证券", "weight": 0.10, "is_leader": True},
            ],
            "地产": [
                {"code": "000002", "name": "万科A", "weight": 0.12, "is_leader": True},
                {"code": "600048", "name": "保利发展", "weight": 0.10, "is_leader": True},
            ],
        }
    
    def identify_sectors_from_sentiment(self, sentiment_news: Dict[str, Any]) -> List[Dict[str, Any]]:
        """从舆情新闻中识别相关板块"""
        title = sentiment_news.get('title', '')
        content = sentiment_news.get('content', '')
        text = f"{title} {content}"
        
        related_sectors = []
        
        # 检查板块映射
        for keyword, mappings in self.sector_mappings.items():
            if keyword in text:
                for mapping in mappings:
                    sector_info = {
                        'sector_code': self._get_sector_code(mapping['sector']),
                        'sector_name': mapping['sector'],
                        'impact': mapping['impact'],
                        'relevance': mapping['weight'],
                        'reasoning': mapping['reasoning'],
                    }
                    # 避免重复添加同一板块
                    if not any(s['sector_name'] == sector_info['sector_name'] for s in related_sectors):
                        related_sectors.append(sector_info)
        
        return related_sectors
    
    def extract_related_stocks(
        self, 
        sector: str, 
        max_count: int = 10,
        leaders_only: bool = False
    ) -> List[Dict[str, Any]]:
        """
        从板块提取相关个股
        
        Args:
            sector: 板块名称
            max_count: 最大数量
            leaders_only: 只要龙头股
        
        Returns:
            个股列表
        """
        stocks = self.sector_stocks.get(sector, [])
        
        if leaders_only:
            stocks = [s for s in stocks if s.get('is_leader', False)]
        
        # 按权重排序
        stocks.sort(key=lambda x: x.get('weight', 0), reverse=True)
        
        return stocks[:max_count]
    
    def calculate_stock_relevance_score(self, stock: Dict, sector_relevance: float) -> Dict[str, Any]:
        """
        计算个股推荐度评分
        
        Args:
            stock: 个股信息
            sector_relevance: 板块相关度
        
        Returns:
            评分结果
        """
        score = 0
        
        # 1. 板块地位权重 (30分)
        if stock.get('is_leader', False):
            score += 30
        else:
            score += 15
        
        # 2. 基本面质量 (25分)
        # 简化处理，实际应该从数据库获取
        score += 20  # 假设大多数股票质量尚可
        
        # 3. 估值吸引力 (20分)
        # 简化处理
        score += 15  # 假设估值合理
        
        # 4. 技术面时机 (15分)
        # 简化处理
        score += 10  # 假设技术面中性
        
        # 5. 板块相关度 (10分)
        score += sector_relevance * 10
        
        return {
            'stock': stock,
            'score': min(score, 100),
            'recommendation': self._generate_stock_recommendation(score),
            'confidence': 'medium' if score >= 70 else 'low'
        }
    
    def _generate_stock_recommendation(self, score: int) -> str:
        """生成个股操作建议"""
        if score >= 85:
            return "强烈推荐，龙头股，可适当配置"
        elif score >= 70:
            return "推荐关注，可适量配置"
        elif score >= 55:
            return "中性偏好，观望为主"
        else:
            return "建议观望"
    
    def _get_sector_code(self, sector_name: str) -> str:
        """获取板块代码"""
        sector_codes = {
            '黄金': 'bk_gold',
            '半导体': 'bk_semiconductor',
            '新能源': 'bk_newenergy',
            '消费': 'bk_consumer',
            '银行': 'bk_banks',
            '券商': 'bk_securities',
            '地产': 'bk_realestate',
        }
        return sector_codes.get(sector_name, f'bk_{sector_name}')
    
    def get_sector_statistics(self) -> Dict[str, Any]:
        """获取板块统计信息"""
        return {
            'total_mappings': len(self.sector_mappings),
            'total_sectors': len(self.sector_stocks),
            'mappings': {
                'keyword_count': len(self.sector_mappings),
                'sector_coverage': len(self.sector_stocks)
            }
        }


class StockMatcher:
    """股票名称匹配器"""
    
    def __init__(self):
        """初始化股票匹配器"""
        self.stock_dict = self._build_stock_dict()
    
    def _build_stock_dict(self) -> Dict[str, str]:
        """构建股票名称-代码映射"""
        # 重要股票名称映射（示例）
        return {
            # 贵币茅台
            "茅台": "600519",
            "贵州茅台": "600519",
            
            # 宁德时代
            "宁德时代": "300750",
            
            # 比亚迪
            "比亚迪": "002594",
            
            # 中芯国际
            "中芯国际": "688981",
            
            # 紫金矿业
            "紫金矿业": "601899",
            
            # 山东黄金
            "山东黄金": "600547",
            
            # 招商银行
            "招行": "600036",
            "招商银行": "600036",
            
            # 工商银行
            "工行": "601398",
            "工商银行": "601398",
        }
    
    def match_stocks_in_text(self, text: str) -> List[Dict[str, Any]]:
        """在文本中匹配股票"""
        matched = []
        
        for name, code in self.stock_dict.items():
            if name in text:
                matched.append({
                    'code': code,
                    'name': name,
                    'match_type': 'direct',
                    'confidence': 1.0
                })
        
        return matched


class InvestmentAdvisor:
    """投资建议生成器"""
    
    def __init__(self):
        """初始化投资建议器"""
        pass
    
    def generate_investment_tip(
        self, 
        sentiment: Dict[str, Any],
        related_stocks: List[Dict[str, Any]],
        impact_predictions: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """
        生成投资建议
        
        Args:
            sentiment: 舆情信息
            related_stocks: 相关个股
            impact_predictions: 影响预测
        
        Returns:
            投资建议
        """
        sentiment_importance = sentiment.get('importance_score', 0)
        sentiment_type = sentiment.get('sentiment_tag', 'neutral')
        
        # 分析舆情影响
        impact_analysis = self._analyze_sentiment_impact(sentiment, impact_predictions)
        
        # 筛选推荐个股
        recommended_stocks = self._filter_recommended_stocks(related_stocks, sentiment_type)
        
        # 生成操作建议
        operation_advice = self._generate_operation_advice(impact_analysis, sentiment_importance)
        
        # 风险提示
        risk_warnings = self._generate_risk_warnings(sentiment, impact_predictions)
        
        return {
            'sentiment_importance': sentiment_importance,
            'sentiment_type': sentiment_type,
            'impact_analysis': impact_analysis,
            'recommended_stocks': recommended_stocks,
            'operation_advice': operation_advice,
            'risk_warnings': risk_warnings,
            'confidence': 'medium'
        }
    
    def _analyze_sentiment_impact(self, sentiment: Dict, predictions: List) -> Dict:
        """分析舆情影响"""
        # 简化处理
        high_positive_count = sum(1 for p in predictions if p.get('positive_probability', 0.5) > 0.7)
        
        if high_positive_count >= len(predictions) * 0.6:
            return {
                'overall_impact': 'positive',
                'confidence': 'high',
                'description': '整体利好，多数板块受正面影响'
            }
        elif high_positive_count >= len(predictions) * 0.3:
            return {
                'overall_impact': 'mixed',
                'confidence': 'medium',
                'description': '影响不一，需具体分析'
            }
        else:
            return {
                'overall_impact': 'negative',
                'confidence': 'low',
                'description': '整体偏空，建议谨慎'
            }
    
    def _filter_recommended_stocks(self, stocks: List[Dict], sentiment_type: str) -> List[Dict]:
        """筛选推荐个股"""
        # 根据情感倾向筛选
        if sentiment_type == 'positive':
            # 优先推荐龙头股
            return [s for s in stocks if s.get('is_leader', False)][:5]
        elif sentiment_type == 'negative':
            # 避开相关股票
            return []
        else:
            # 中性，推荐龙头
            return [s for s in stocks if s.get('is_leader', False)][:3]
    
    def _generate_operation_advice(self, impact_analysis: Dict, importance: int) -> str:
        """生成操作建议"""
        if impact_analysis['overall_impact'] == 'positive' and importance >= 80:
            return "利好明显，建议关注龙头股，逢低介入"
        elif impact_analysis['overall_impact'] == 'negative' and importance >= 80:
            return "利空影响，建议减仓或规避"
        else:
            return "影响混合，建议观望为主，等待更明确信号"
    
    def _generate_risk_warnings(self, sentiment: Dict, predictions: List) -> List[str]:
        """生成风险提示"""
        warnings = []
        
        # 检查是否有高风险场景
        high_negative_predictions = [p for p in predictions if p.get('negative_probability', 0) > 0.7]
        if high_negative_predictions:
            warnings.append(f"注意：{len(high_negative_predictions)}个板块受负面影响")
        
        sentiment_importance = sentiment.get('importance_score', 0)
        if sentiment_importance >= 90:
            warnings.append("极重要性舆情，建议密切关注")
        
        return warnings


# 全局实例
_sector_mapper = None
_stock_matcher = None
_investment_advisor = None


def get_sector_mapper() -> SectorMapper:
    """获取板块映射器全局实例"""
    global _sector_mapper
    if _sector_mapper is None:
        _sector_mapper = SectorMapper()
    return _sector_mapper


def get_stock_matcher() -> StockMatcher:
    """获取股票匹配器全局实例"""
    global _stock_matcher
    if _stock_matcher is None:
        _stock_matcher = StockMatcher()
    return _stock_matcher


def get_investment_advisor() -> InvestmentAdvisor:
    """获取投资建议器全局实例"""
    global _investment_advisor
    if _investment_advisor is None:
        _investment_advisor = InvestmentAdvisor()
    return _investment_advisor