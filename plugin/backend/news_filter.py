"""
舆情智能过滤引擎

提供：
- 基于关键词的舆情重要性评分
- 智能过滤和排序
- 板块关联识别
- 情感标签分析
"""

import re
import time
from typing import List, Dict, Any, Optional, Set, Tuple
from datetime import datetime, timedelta
from loguru import logger


class NewsFilter:
    """舆情智能过滤器"""
    
    def __init__(self):
        """初始化过滤器"""
        # 导入关键词库
        try:
            from sentiment_keywords import get_sentiment_keywords
            from user_keywords import get_user_keywords
            self.keyword_lib = get_sentiment_keywords()
            self.user_keywords = get_user_keywords()
            self.use_keyword_lib = True
            logger.info("使用SentimentKeywords关键词库和UserKeywords")
        except ImportError:
            # 回退到内置关键词库
            self.core_keywords = self._init_core_keywords()
            self.sector_mappings = self._init_sector_mappings()
            self.synonyms = self._init_synonyms()
            self.user_keywords = None
            self.use_keyword_lib = False
            logger.warning("回退到内置关键词库")
        
        # 黑名单
        self.blacklist: Set[str] = {'广告', '软文', '推广', '赞助'}
    
    def _init_core_keywords(self) -> Dict[str, Dict[str, Any]]:
        """初始化核心关键词词库（回退用）"""
        return {
            "us_economy": {
                "keywords": ["美联储", "FOMC", "利率决议", "降息", "加息", "利率", "鲍威尔", "非农", "失业率", "CPI", "PCE", "GDP", "PMI"],
                "importance": 90,
                "category": "macro",
            },
            "cn_policy": {
                "keywords": ["央行", "降准", "降息", "LPR", "MLF", "社融", "M2", "证监会", "IPO", "再融资"],
                "importance": 85,
                "category": "policy",
            },
            "market_sentiment": {
                "keywords": ["牛市", "熊市", "反弹", "跳水", "涨停", "跌停", "北向资金", "南向资金"],
                "importance": 60,
                "category": "market",
            },
        }
    
    def _init_sector_mappings(self) -> Dict[str, List[Dict[str, Any]]]:
        """初始化板块映射库（回退用）"""
        return {
            "降息": [
                {"sector": "地产", "impact": "positive", "weight": 0.9, "reasoning": "降低资金成本"},
                {"sector": "银行", "impact": "negative", "weight": 0.7, "reasoning": "息差收窄"},
            ],
            "美联储": [
                {"sector": "黄金", "impact": "neutral", "weight": 0.95, "reasoning": "货币政策影响"},
            ],
        }
    
    def _init_synonyms(self) -> Dict[str, List[str]]:
        """初始化同义词映射（回退用）"""
        return {
            "降息": ["宽松", "鸽派"],
            "加息": ["收紧", "鹰派"],
        }
    
    def filter_important_news(self, news_list: List[Dict[str, Any]], min_score: int = 60) -> List[Dict[str, Any]]:
        """
        过滤重要的舆情新闻
        
        Args:
            news_list: 原始舆情列表
            min_score: 最低重要性评分
            
        Returns:
            过滤后的重要舆情列表
        """
        filtered = []
        
        for news in news_list:
            # 检查黑名单
            if self._is_blacklisted(news):
                continue
            
            # 计算重要性评分
            score_data = self.calculate_importance_score(news)
            score = score_data['score']
            
            if score >= min_score:
                # 添加评分信息
                news['importance_score'] = score
                news['importance_breakdown'] = score_data['breakdown']
                news['sentiment_tag'] = self._analyze_sentiment(news)
                
                # 添加板块关联
                sectors = self._identify_sectors(news)
                if sectors:
                    news['related_sectors'] = sectors
                
                filtered.append(news)
        
        # 按重要性排序
        filtered.sort(key=lambda x: x['importance_score'], reverse=True)
        
        return filtered
    
    def calculate_importance_score(self, news: Dict[str, Any]) -> Dict[str, Any]:
        """
        计算舆情重要性评分 (0-100)
        
        评分因素:
        1. 关键词匹配权重 (0-60分)
        2. 时效性加成 (0-20分)
        3. 来源权威性 (0-10分)
        4. 市场相关度 (0-10分)
        """
        score = 0
        breakdown = {
            'keyword_score': 0,
            'time_bonus': 0,
            'source_score': 0,
            'market_score': 0,
        }
        
        title = news.get('title', '')
        content = news.get('content', '')
        text = f"{title} {content}"
        
        # 1. 关键词匹配 (0-60分)
        matched_keywords = self._match_keywords(text)
        if matched_keywords:
            # 取最高权重关键词的分数
            max_weight = max(kw['importance'] for kw in matched_keywords)
            keyword_score = min(max_weight, 60)
            
            # 匹配数量加成
            count_bonus = min(len(matched_keywords) * 2, 10)
            breakdown['keyword_score'] = min(keyword_score + count_bonus, 60)
        
        # 2. 时效性加成 (0-20分)
        published_at = news.get('published_at')
        if published_at:
            time_diff = self._calculate_time_diff(published_at)
            if time_diff < 3600:  # 1小时内
                breakdown['time_bonus'] = 20
            elif time_diff < 21600:  # 6小时内
                breakdown['time_bonus'] = 15
            elif time_diff < 86400:  # 24小时内
                breakdown['time_bonus'] = 10
        
        # 3. 来源权威性 (0-10分)
        source = news.get('source', '').lower()
        authority_scores = {
            'fed': 10, 'frb': 10,  # 美联储官方
            'bls': 9, 'bea': 9,   # 美国统计局
            'eastmoney': 8, 'em': 8,  # 东财
            'caixin': 9,         # 财新
            'reuters': 8,        # 路透
            'bloomberg': 8,      # 彭博
            'wallstreetcn': 8,   # 华尔街见闻
            'sina': 6,           # 新浪
        }
        breakdown['source_score'] = authority_scores.get(source, 5)
        
        # 4. 市场相关度 (0-10分)
        market_terms = ["A股", "港股", "美股", "上证", "深证", "创业板", "科创板"]
        if any(term in title for term in market_terms):
            breakdown['market_score'] = 10
        
        # 计算总分
        score = sum(breakdown.values())
        
        return {
            'score': min(score, 100),
            'breakdown': breakdown,
        }
    
    def _match_keywords(self, text: str) -> List[Dict[str, Any]]:
        """匹配文本中的关键词"""
        matched = []
        
        if self.use_keyword_lib:
            # 使用SentimentKeywords库
            all_keywords = self.keyword_lib.get_all_keywords()
            
            for category, keywords in all_keywords.items():
                for keyword in keywords:
                    if keyword in text:
                        # 获取关键词详细信息
                        keyword_info = self.keyword_lib.get_keyword_info(keyword)
                        if keyword_info:
                            matched.append({
                                'keyword': keyword,
                                'category': keyword_info['category'],
                                'importance': keyword_info['importance'],
                                'source': 'core',  # 标记为核心词库
                            })
                        else:
                            matched.append({
                                'keyword': keyword,
                                'category': category,
                                'importance': 70,  # 默认重要性
                                'source': 'core',
                            })
            
            # 添加用户自定义关键词匹配
            if self.user_keywords:
                user_matched = self.user_keywords.find_matching_keywords(text, min_importance=50)
                for user_kw in user_matched:
                    matched.append({
                        'keyword': user_kw['keyword'],
                        'category': f"user_{user_kw['category']}",
                        'importance': user_kw['importance'],
                        'source': 'user',  # 标记为用户词库
                        'notes': user_kw.get('notes', ''),
                    })
        else:
            # 回退到内置关键词库
            for category, data in self.core_keywords.items():
                if isinstance(data, dict) and 'keywords' in data:
                    for keyword in data['keywords']:
                        if keyword in text:
                            matched.append({
                                'keyword': keyword,
                                'category': category,
                                'importance': data.get('importance', 70),
                                'source': 'core',
                            })
        
        return matched
    
    def _calculate_time_diff(self, published_at: str) -> int:
        """计算时间差（秒）"""
        try:
            # 尝试多种时间格式
            formats = [
                '%Y-%m-%d %H:%M:%S',
                '%Y-%m-%dT%H:%M:%S',
                '%Y-%m-%d %H:%M',
                '%Y%m%d %H%M%S',
            ]
            
            published_time = None
            for fmt in formats:
                try:
                    published_time = datetime.strptime(published_at, fmt)
                    break
                except ValueError:
                    continue
            
            if published_time:
                time_diff = (datetime.now() - published_time).total_seconds()
                return max(0, time_diff)
        
        except Exception as e:
            logger.debug(f"计算时间差失败: {e}")
        
        return 86400  # 默认24小时
    
    def _analyze_sentiment(self, news: Dict[str, Any]) -> str:
        """分析舆情情感倾向"""
        title = news.get('title', '')
        content = news.get('content', '')
        text = f"{title} {content}"
        
        # 正面词汇
        positive_words = [
            '增长', '上升', '上涨', '超预期', '利好', '突破', '创新高',
            '改善', '回升', '复苏', '上涨', '涨幅', '盈利', '利润',
        ]
        
        # 负面词汇
        negative_words = [
            '下降', '下跌', '下滑', '低于预期', '利空', '暴跌', '创新低',
            '恶化', '衰退', '亏损', '债务', '危机', '风险', '下跌',
        ]
        
        positive_count = sum(1 for word in positive_words if word in text)
        negative_count = sum(1 for word in negative_words if word in text)
        
        if positive_count > negative_count:
            return 'positive'
        elif negative_count > positive_count:
            return 'negative'
        else:
            return 'neutral'
    
    def _identify_sectors(self, news: Dict[str, Any]) -> List[Dict[str, Any]]:
        """识别舆情相关的板块"""
        title = news.get('title', '')
        content = news.get('content', '')
        text = f"{title} {content}"
        
        related_sectors = []
        
        # 检查板块映射
        if self.use_keyword_lib:
            # 使用SentimentKeywords的板块识别
            # 先检查板块关键词
            sector_keywords = self.keyword_lib.sector_keywords
            for sector_name, keywords in sector_keywords.items():
                for keyword in keywords:
                    if keyword in text:
                        sector_info = {
                            'sector_code': self._get_sector_code(sector_name),
                            'sector_name': sector_name,
                            'impact': 'positive',  # 默认正面影响
                            'relevance': 0.8,      # 默认相关度
                            'reasoning': f'包含"{keyword}"相关词汇',
                        }
                        # 避免重复添加同一板块
                        if not any(s['sector_name'] == sector_name for s in related_sectors):
                            related_sectors.append(sector_info)
            
            # 检查内置的板块映射（如降息->地产等）
            # 这里可以扩展更多的规则映射
        else:
            # 回退到内置映射
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
                        related_sectors.append(sector_info)
        
        return related_sectors
    
    def _get_sector_code(self, sector_name: str) -> str:
        """获取板块代码"""
        # 简单映射，实际应该从数据库获取
        sector_codes = {
            '地产': 'bk_real_estate',
            '银行': 'bk_banks',
            '券商': 'bk_securities',
            '黄金': 'bk_gold',
            '半导体': 'bk_semiconductor',
            '医药': 'bk_healthcare',
            '光伏': 'bk_solar',
            '消费': 'bk_consumer',
        }
        return sector_codes.get(sector_name, f'bk_{sector_name}')
    
    def _is_blacklisted(self, news: Dict[str, Any]) -> bool:
        """检查是否在黑名单中"""
        title = news.get('title', '')
        
        # 检查内置黑名单
        for blacklist_word in self.blacklist:
            if blacklist_word in title:
                return True
        
        # 检查用户自定义黑名单
        if self.user_keywords:
            return self.user_keywords.is_blacklisted(title)
        
        return False
    
    def expand_synonyms(self, keyword: str) -> List[str]:
        """扩展关键词同义词"""
        if self.use_keyword_lib:
            return self.keyword_lib.expand_synonyms(keyword)
        else:
            # 回退到内置同义词映射
            synonyms = [keyword]
            
            for main_word, syn_list in self.synonyms.items():
                if keyword in syn_list:
                    synonyms.append(main_word)
                    synonyms.extend(syn_list)
                elif keyword == main_word:
                    synonyms.extend(syn_list)
            
            return list(set(synonyms))


# 全局实例
_news_filter = None


def get_news_filter() -> NewsFilter:
    """获取新闻过滤器全局实例"""
    global _news_filter
    if _news_filter is None:
        _news_filter = NewsFilter()
    return _news_filter