"""
AI智能关键词推荐模块

提供：
- 基于历史高影响力新闻的学习引擎
- 高频词汇提取和分析
- 新热点词汇发现
- 关键词建议生成
- 推荐接受机制
"""

import re
import json
from typing import List, Dict, Any, Optional, Set, Tuple
from datetime import datetime, timedelta
from collections import Counter
from loguru import logger
from dataclasses import dataclass


@dataclass
class KeywordSuggestion:
    """关键词建议"""
    keyword: str
    frequency: int           # 出现频率
    suggested_importance: int  # 建议重要性
    sample_news: List[Dict[str, Any]]  # 示例新闻
    confidence: str          # 置信度 (high/medium/low)
    reasoning: str          # 推荐理由
    estimated_impact: str    # 预估影响 (positive/negative/neutral)


class KeywordLearner:
    """关键词学习引擎"""
    
    def __init__(self, db_path: Optional[str] = None):
        """
        初始化学习引擎
        
        Args:
            db_path: 舆情数据库路径
        """
        if db_path is None:
            from storage import storage
            self.db_path = storage.data_dir / "sentiment.db"
        else:
            self.db_path = db_path
        
        self.conn = None
        self._connect()
        
        # 尝试导入关键词库
        try:
            from sentiment_keywords import get_sentiment_keywords
            self.keyword_lib = get_sentiment_keywords()
            self.use_keyword_lib = True
        except ImportError:
            self.keyword_lib = None
            self.use_keyword_lib = False
    
    def _connect(self):
        """连接到舆情数据库（check_same_thread=False：允许asyncio.to_thread工作线程访问）"""
        try:
            import sqlite3
            self.conn = sqlite3.connect(
                str(self.db_path),
                timeout=10.0,
                check_same_thread=False,
            )
            self.conn.row_factory = sqlite3.Row
            logger.info("关键词学习引擎连接成功")
        except Exception as e:
            logger.error(f"关键词学习引擎连接失败: {e}")
            self.conn = None
    
    def analyze_high_impact_news(self, days: int = 30) -> List[KeywordSuggestion]:
        """
        分析过去N天内高影响力新闻的共同特征
        
        Args:
            days: 分析天数
        
        Returns:
            关键词建议列表
        """
        if not self.conn:
            return []
        
        try:
            # 获取高影响力新闻
            cutoff_date = (datetime.now() - timedelta(days=days)).strftime('%Y-%m-%d %H:%M:%S')
            
            cursor = self.conn.execute("""
                SELECT * FROM sentiment_news 
                WHERE importance_score >= 70
                AND published_at >= ?
                ORDER BY importance_score DESC, published_at DESC
                LIMIT 500
            """, (cutoff_date,))
            
            high_impact_news = [dict(row) for row in cursor.fetchall()]
            
            if not high_impact_news:
                logger.info(f"过去{days}天内没有高影响力新闻")
                return []
            
            logger.info(f"分析 {len(high_impact_news)} 条高影响力新闻")
            
            # 提取词汇并分析
            suggestions = self._extract_and_analyze_keywords(high_impact_news)
            
            return suggestions
        
        except Exception as e:
            logger.error(f"分析高影响力新闻失败: {e}")
            return []
    
    def _extract_and_analyze_keywords(self, news_list: List[Dict[str, Any]]) -> List[KeywordSuggestion]:
        """从新闻列表中提取和分析关键词"""
        
        # 1. 提取所有词汇
        word_freq = Counter()
        word_news_map = {}  # 词汇 -> 包含该词汇的新闻列表
        
        for news in news_list:
            title = news.get('title', '')
            content = news.get('content', '')
            text = f"{title} {content}"
            
            # 提取词汇
            words = self._extract_words(text)
            
            for word in words:
                # 过滤掉太短或太长的词
                if len(word) < 2 or len(word) > 6:
                    continue
                
                # 过滤掉纯数字
                if word.isdigit():
                    continue
                
                word_freq[word] += 1
                
                if word not in word_news_map:
                    word_news_map[word] = []
                word_news_map[word].append(news)
        
        if not word_freq:
            logger.info("没有提取到有效词汇")
            return []
        
        # 2. 过滤掉已知关键词
        new_keywords = self._filter_known_keywords(word_freq)
        
        if not new_keywords:
            logger.info("没有发现新关键词")
            return []
        
        # 3. 分析新关键词并生成建议
        suggestions = []
        
        for word, freq in new_keywords.items():
            # 至少出现3次才考虑
            if freq < 3:
                continue
            
            # 获取示例新闻
            sample_news = word_news_map.get(word, [])[:3]
            
            # 计算建议重要性
            suggested_importance = min(70 + freq * 2, 95)
            
            # 分析该词汇的影响力特征
            avg_importance = sum(
                news.get('importance_score', 0) 
                for news in sample_news
            ) / len(sample_news) if sample_news else 70
            
            # 调整建议重要性
            suggested_importance = max(suggested_importance, int(avg_importance))
            
            # 评估置信度
            confidence = self._assess_confidence(freq, len(sample_news))
            
            # 生成推荐理由
            reasoning = self._generate_reasoning(word, freq, sample_news)
            
            # 预估影响方向
            estimated_impact = self._estimate_impact(sample_news)
            
            suggestion = KeywordSuggestion(
                keyword=word,
                frequency=freq,
                suggested_importance=suggested_importance,
                sample_news=sample_news,
                confidence=confidence,
                reasoning=reasoning,
                estimated_impact=estimated_impact
            )
            
            suggestions.append(suggestion)
        
        # 按频率排序，取Top 20
        suggestions.sort(key=lambda x: x.frequency, reverse=True)
        return suggestions[:20]
    
    def _extract_words(self, text: str) -> Set[str]:
        """从文本中提取中文词汇"""
        words = set()
        
        # 简单的中文分词（2-6字的中文词汇）
        # 匹配2-6个连续的中文字符
        chinese_pattern = re.compile(r'[\u4e00-\u9fa5]{2,6}')
        matches = chinese_pattern.findall(text)
        
        for match in matches:
            # 过滤常见无意义词汇
            if self._is_meaningful_word(match):
                words.add(match)
        
        # 提取英文缩写和术语（2-5个连续大写字母）
        english_pattern = re.compile(r'[A-Z]{2,5}')
        english_matches = english_pattern.findall(text)
        
        for match in english_matches:
            # 过滤常见无意义缩写
            if match not in ['THE', 'AND', 'FOR', 'WITH', 'FROM', 'THAT', 'THIS']:
                words.add(match)
        
        return words
    
    def _is_meaningful_word(self, word: str) -> bool:
        """判断词汇是否有意义"""
        # 常见无意义词汇黑名单
        meaningless_words = {
            '这个', '那个', '什么', '怎么', '如何', '为什么',
            '可以', '应该', '需要', '必须', '可能', '或者',
            '以及', '还有', '或者', '但是', '因为', '所以',
            '之一', '之一', '首次', '再次', '继续', '仍然',
            '包括', '通过', '经过', '根据', '按照', '关于',
            '相关', '重要', '主要', '基本', '一般', '目前',
            '显示', '表明', '认为', '表示', '宣布', '发布',
            '报告', '消息', '新闻', '文章', '内容', '信息',
        }
        
        if word in meaningless_words:
            return False
        
        # 过滤掉纯数字或包含大量数字的词
        if re.search(r'\d{3,}', word):
            return False
        
        # 过滤掉特殊字符开头的词
        if re.match(r'^[^a-zA-Z\u4e00-\u9fa5]', word):
            return False
        
        return True
    
    def _filter_known_keywords(self, word_freq: Counter) -> Dict[str, int]:
        """过滤掉已知关键词"""
        new_keywords = {}
        
        for word, freq in word_freq.items():
            # 检查是否在核心词库中
            if self.use_keyword_lib:
                keyword_info = self.keyword_lib.get_keyword_info(word)
                if keyword_info:
                    continue  # 已存在于核心词库
            
            # 检查是否在用户自定义词库中
            try:
                from user_keywords import get_user_keywords
                user_keywords = get_user_keywords()
                all_user_keywords = user_keywords.get_all_keywords()
                
                if any(kw['keyword'] == word for kw in all_user_keywords):
                    continue  # 已存在于用户词库
            except ImportError:
                pass
            
            # 过滤掉常见词汇
            if word in self._get_common_words():
                continue
            
            new_keywords[word] = freq
        
        return new_keywords
    
    def _get_common_words(self) -> Set[str]:
        """获取常见词汇（停用词）"""
        return {
            '证券', '股票', '公司', '企业', '集团', '股份', '有限',
            '市场', '行业', '板块', '个股', '大盘', '股市',
            '今天', '昨天', '本月', '今年', '昨日', '当日',
            '中国', '美国', '全球', '国内', '国际', '海外',
            '相关', '主要', '重要', '重大', '关键', '核心',
            '发布', '宣布', '报告', '显示', '表明', '认为',
            '增长', '下降', '上涨', '下跌', '变化', '调整',
            '消息', '新闻', '公告', '通知', '声明', '说明',
        }
    
    def _assess_confidence(self, frequency: int, sample_count: int) -> str:
        """评估推荐置信度"""
        if frequency >= 10 and sample_count >= 5:
            return "high"
        elif frequency >= 5 and sample_count >= 3:
            return "medium"
        else:
            return "low"
    
    def _generate_reasoning(self, word: str, frequency: int, samples: List[Dict]) -> str:
        """生成推荐理由"""
        avg_importance = sum(
            s.get('importance_score', 0) for s in samples
        ) / len(samples) if samples else 0
        
        reasons = []
        
        if frequency >= 10:
            reasons.append(f"过去30天出现{frequency}次")
        elif frequency >= 5:
            reasons.append(f"过去30天出现{frequency}次")
        else:
            reasons.append(f"出现{frequency}次")
        
        if avg_importance >= 80:
            reasons.append("多出现在高重要性新闻中")
        elif avg_importance >= 70:
            reasons.append("多出现在中高重要性新闻中")
        
        # 分析新闻来源
        sources = set()
        for s in samples:
            source = s.get('source', '')
            if source:
                sources.add(source)
        
        if len(sources) >= 2:
            reasons.append(f"出现在{len(sources)}个不同数据源")
        
        # 分析时效性
        recent_count = sum(
            1 for s in samples 
            if self._is_recent_news(s.get('published_at', ''))
        )
        
        if recent_count >= len(samples) * 0.7:
            reasons.append("近期频繁出现")
        
        return "，".join(reasons) if reasons else "基于历史频率分析"
    
    def _is_recent_news(self, published_at: str) -> bool:
        """判断新闻是否近期（7天内）"""
        try:
            pub_time = datetime.strptime(published_at, '%Y-%m-%d %H:%M:%S')
            return (datetime.now() - pub_time).days <= 7
        except:
            return False
    
    def _estimate_impact(self, samples: List[Dict]) -> str:
        """预估影响方向"""
        if not samples:
            return "neutral"
        
        positive_count = sum(1 for s in samples if s.get('sentiment_tag') == 'positive')
        negative_count = sum(1 for s in samples if s.get('sentiment_tag') == 'negative')
        
        if positive_count > negative_count:
            return "positive"
        elif negative_count > positive_count:
            return "negative"
        else:
            return "neutral"
    
    def generate_suggestions(self, days: int = 30) -> List[Dict[str, Any]]:
        """生成关键词建议（对外接口）"""
        suggestions = self.analyze_high_impact_news(days)
        
        result = []
        for suggestion in suggestions:
            result.append({
                'keyword': suggestion.keyword,
                'frequency': suggestion.frequency,
                'suggested_importance': suggestion.suggested_importance,
                'sample_news': [
                    {
                        'title': news.get('title', ''),
                        'importance_score': news.get('importance_score', 0),
                        'published_at': news.get('published_at', ''),
                        'source': news.get('source', '')
                    }
                    for news in suggestion.sample_news
                ],
                'confidence': suggestion.confidence,
                'reasoning': suggestion.reasoning,
                'estimated_impact': suggestion.estimated_impact
            })
        
        return result
    
    def accept_suggestion(
        self, 
        keyword: str, 
        suggested_importance: int,
        category: str = "AI推荐"
    ) -> bool:
        """
        接受AI推荐的关键词，添加到用户词库
        
        Args:
            keyword: 关键词
            suggested_importance: 建议重要性
            category: 分类
        
        Returns:
            是否添加成功
        """
        try:
            from user_keywords import get_user_keywords
            user_keywords = get_user_keywords()
            
            user_keywords.add_keyword(
                keyword=keyword,
                category=category,
                importance=suggested_importance,
                notes=f"AI推荐: {category}"
            )
            
            logger.info(f"用户接受AI推荐关键词: {keyword}")
            return True
        
        except Exception as e:
            logger.error(f"接受推荐关键词失败: {e}")
            return False
    
    def reject_suggestion(self, keyword: str) -> bool:
        """
        拒绝AI推荐的关键词，加入黑名单
        
        Args:
            keyword: 关键词
        
        Returns:
            是否添加成功
        """
        try:
            from user_keywords import get_user_keywords
            user_keywords = get_user_keywords()
            
            # 添加到黑名单
            user_keywords.add_blacklist(keyword)
            
            logger.info(f"用户拒绝AI推荐关键词，已加入黑名单: {keyword}")
            return True
        
        except Exception as e:
            logger.error(f"拒绝推荐关键词失败: {e}")
            return False
    
    def get_learning_statistics(self, days: int = 30) -> Dict[str, Any]:
        """获取学习统计信息"""
        if not self.conn:
            return {}
        
        try:
            cutoff_date = (datetime.now() - timedelta(days=days)).strftime('%Y-%m-%d %H:%M:%S')
            
            cursor = self.conn.execute("""
                SELECT 
                    COUNT(*) as total_news,
                    COUNT(CASE WHEN importance_score >= 80 THEN 1 END) as high_importance,
                    COUNT(CASE WHEN importance_score >= 60 THEN 1 END) as medium_importance
                FROM sentiment_news 
                WHERE published_at >= ?
            """, (cutoff_date,))
            
            stats = dict(cursor.fetchone())
            
            # 添加学习统计
            suggestions = self.generate_suggestions(days)
            stats['total_suggestions'] = len(suggestions)
            stats['high_confidence_suggestions'] = sum(
                1 for s in suggestions if s.get('confidence') == 'high'
            )
            
            return stats
        
        except Exception as e:
            logger.error(f"获取学习统计失败: {e}")
            return {}
    
    def close(self):
        """关闭数据库连接"""
        if self.conn:
            self.conn.close()
            logger.info("关键词学习引擎连接已关闭")


# 全局实例
_keyword_learner = None


def get_keyword_learner() -> KeywordLearner:
    """获取关键词学习引擎全局实例"""
    global _keyword_learner
    if _keyword_learner is None:
        _keyword_learner = KeywordLearner()
    return _keyword_learner