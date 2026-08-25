"""
个股匹配和筛选模块

提供：
- 从舆情文本中提取直接提及的股票
- 股票名称/代码映射
- 产业链上下游关联
- 个股质量筛选和评分
"""

import re
from typing import List, Dict, Any, Optional, Set
from loguru import logger


class StockMatcher:
    """个股匹配引擎"""
    
    def __init__(self):
        """初始化个股匹配器"""
        # 公司名称映射（示例数据，实际应从数据库或API获取）
        self.company_name_map = {
            "宁德时代": "300750",
            "比亚迪": "002594", 
            "贵州茅台": "600519",
            "腾讯控股": "00700",
            "阿里巴巴": "09988",
            "美团": "03690",
            "中芯国际": "688981",
            "隆基绿能": "601012",
            "药明康德": "603259",
            "恒瑞医药": "600276",
            "招商银行": "600036",
            "平安银行": "000001",
            "中国平安": "601318",
            "五粮液": "000858",
            "长江电力": "600900",
            "紫金矿业": "601899",
            "海尔智家": "600690",
            "美的集团": "000333",
            "格力电器": "000651",
            "万科A": "000002",
            "保利发展": "600048",
        }
        
        # 股票代码模式
        self.stock_patterns = [
            r'\b[0-3]{1}[0-9]{5}\b',  # A股代码 6位数字
            r'\b[0-9]{5}\.SH\b',      # 上交所
            r'\b[0-9]{5}\.SZ\b',      # 深交所
            r'\b[0-9]{5}\.BJ\b',      # 北交所
            r'\b0[0-9]{4}\b',         # 港股5位
            r'\b[0-9]{4}\.HK\b',      # 港股
        ]
        
        # 产业链映射
        self.industry_chain = {
            "台积电": ["中芯国际", "华虹半导体"],
            "特斯拉": ["比亚迪", "宁德时代", "拓普集团"],
            "苹果": ["立讯精密", "歌尔股份", "蓝思科技"],
            "华为": ["中芯国际", "京东方A", "欧菲光"],
            "英伟达": ["中科曙光", "浪潮信息", "寒武纪"],
        }
        
    def match_stocks_in_text(self, text: str) -> List[Dict[str, Any]]:
        """从文本中匹配股票"""
        if not text:
            return []
            
        matched_stocks = []
        seen_stocks = set()
        
        # 匹配公司名称
        for company_name, stock_code in self.company_name_map.items():
            if company_name in text and stock_code not in seen_stocks:
                matched_stocks.append({
                    'stock_code': stock_code,
                    'stock_name': company_name,
                    'match_type': 'direct_name',
                    'confidence': 0.95
                })
                seen_stocks.add(stock_code)
        
        # 匹配股票代码
        for pattern in self.stock_patterns:
            matches = re.findall(pattern, text)
            for match in matches:
                stock_code = self._normalize_stock_code(match)
                if stock_code and stock_code not in seen_stocks:
                    stock_name = self._get_stock_name(stock_code)
                    matched_stocks.append({
                        'stock_code': stock_code,
                        'stock_name': stock_name or stock_code,
                        'match_type': 'code',
                        'confidence': 0.90
                    })
                    seen_stocks.add(stock_code)
        
        logger.debug(f"文本匹配到 {len(matched_stocks)} 只股票")
        return matched_stocks
    
    def find_industry_chain_stocks(self, stock_name: str) -> List[Dict[str, Any]]:
        """查找产业链相关股票"""
        related_stocks = []
        
        # 检查是否在产业链映射中
        if stock_name in self.industry_chain:
            related_names = self.industry_chain[stock_name]
            for related_name in related_names:
                if related_name in self.company_name_map:
                    related_stocks.append({
                        'stock_code': self.company_name_map[related_name],
                        'stock_name': related_name,
                        'relation_type': 'industry_chain',
                        'confidence': 0.70
                    })
        
        return related_stocks
    
    def filter_stocks_by_quality(self, stocks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """按质量筛选股票"""
        # 这里应该连接真实的股票基本面数据
        # 目前做简单的示例筛选
        
        # 剔除ST股票（示例：假设名称中包含ST的）
        filtered = [s for s in stocks if 'ST' not in s.get('stock_name', '')]
        
        # 按某种排序规则排序
        filtered = sorted(filtered, key=lambda x: x.get('confidence', 0), reverse=True)
        
        return filtered
    
    def _normalize_stock_code(self, code: str) -> Optional[str]:
        """标准化股票代码"""
        if not code:
            return None
            
        code = code.upper().replace('.SH', '').replace('.SZ', '').replace('.BJ', '').replace('.HK', '')
        
        # A股代码
        if len(code) == 6 and code.isdigit():
            return code
            
        # 港股代码  
        if len(code) == 5 and code.isdigit():
            return code
            
        return None
    
    def _get_stock_name(self, stock_code: str) -> Optional[str]:
        """根据代码获取股票名称"""
        # 反向查找
        for name, code in self.company_name_map.items():
            if code == stock_code:
                return name
        return None


def get_stock_matcher() -> StockMatcher:
    """获取股票匹配器实例"""
    return StockMatcher()
