"""
舆情监控主模块

提供：
- 多源舆情数据获取
- 智能过滤和重要性评分
- 板块关联分析
- WebSocket实时推送
- 后台监控循环
"""

import asyncio
import re
import time
import email.utils
from typing import List, Dict, Any, Optional, Set
from datetime import datetime, timedelta
from loguru import logger
import httpx

from sentiment_db import get_sentiment_db
from news_filter import get_news_filter
from impact_analyzer import get_impact_analyzer
from sector_mapper import get_sector_mapper, get_stock_matcher, get_investment_advisor
from ws_manager import ws_manager
from config import config


class NewsDataSource:
    """新闻数据源基类"""
    
    def __init__(self, name: str):
        self.name = name
        self._client = None
        self._headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
    
    def _get_client(self) -> httpx.Client:
        """获取HTTP客户端"""
        if self._client is None:
            self._client = httpx.Client(
                headers=self._headers,
                timeout=10.0,
                limits=httpx.Limits(max_keepalive_connections=0)
            )
        return self._client
    
    def fetch_news(self, limit: int = 50) -> List[Dict[str, Any]]:
        """获取新闻数据（子类实现）"""
        raise NotImplementedError
    
    def close(self):
        """关闭连接"""
        if self._client:
            self._client.close()


class EastMoneyNews(NewsDataSource):
    """东方财富 7×24 全球财经快讯数据源"""

    def __init__(self):
        super().__init__("eastmoney")

    def fetch_news(self, limit: int = 50) -> List[Dict[str, Any]]:
        """获取东财7×24快讯（含中美市场动态，已实测可用）"""
        news_list = []

        try:
            client = self._get_client()

            url = "https://np-listapi.eastmoney.com/comm/web/getFastNewsList"
            params = {
                'client': 'web',
                'biz': 'web_724',
                'fastColumn': '102',  # 全部快讯
                'sortEnd': '',
                'pageSize': min(limit, 50),
                'pageIndex': '1',
                'req_trace': str(int(time.time() * 1000)),
            }

            response = client.get(url, params=params, timeout=10.0)
            if response.status_code == 200:
                data = response.json()
                items = (data.get('data') or {}).get('fastNewsList') or []
                for item in items:
                    title = (item.get('title') or '').strip()
                    if not title:
                        continue
                    news_list.append({
                        'source': 'eastmoney',
                        'title': title,
                        'content': (item.get('summary') or '').strip(),
                        'url': f"https://finance.eastmoney.com/a/{item.get('code', '')}.html",
                        'published_at': item.get('showTime'),  # 已是 %Y-%m-%d %H:%M:%S
                        'country': 'cn',
                        'event_type': 'general',
                    })

        except Exception as e:
            logger.warning(f"东方财富快讯获取失败: {e}")

        return news_list
    
    def _parse_timestamp(self, timestamp: Optional[str]) -> Optional[str]:
        """解析时间戳"""
        if not timestamp:
            return None
        
        try:
            # 处理毫秒时间戳
            if len(str(timestamp)) == 13:
                timestamp = int(timestamp) / 1000
                return datetime.fromtimestamp(timestamp).strftime('%Y-%m-%d %H:%M:%S')
            elif len(str(timestamp)) == 10:
                return datetime.fromtimestamp(int(timestamp)).strftime('%Y-%m-%d %H:%M:%S')
        except:
            pass
        
        return timestamp


class SinaFinance(NewsDataSource):
    """新浪财经滚动新闻数据源"""

    def __init__(self):
        super().__init__("sina")

    def fetch_news(self, limit: int = 30) -> List[Dict[str, Any]]:
        """获取新浪财经滚动新闻（pageid=153 lid=2516 财经频道）"""
        news_list = []

        try:
            client = self._get_client()

            url = "https://feed.mix.sina.com.cn/api/roll/get"
            params = {
                'pageid': '153',
                'lid': '2516',
                'k': '',
                'num': min(limit, 50),
                'page': '1',
            }

            response = client.get(url, params=params, timeout=10.0)
            if response.status_code == 200:
                data = response.json()
                items = (data.get('result') or {}).get('data') or []
                for item in items:
                    title = (item.get('title') or '').strip()
                    if not title:
                        continue
                    # ctime 是秒级时间戳
                    ctime = item.get('ctime')
                    published_at = None
                    if ctime:
                        try:
                            published_at = datetime.fromtimestamp(int(ctime)).strftime('%Y-%m-%d %H:%M:%S')
                        except (ValueError, TypeError):
                            pass
                    news_list.append({
                        'source': 'sina',
                        'title': title,
                        'content': (item.get('intro') or '').strip(),
                        'url': item.get('url', ''),
                        'published_at': published_at,
                        'country': 'cn',
                        'event_type': 'general',
                    })

        except Exception as e:
            logger.warning(f"新浪财经新闻获取失败: {e}")

        return news_list


class FedReserveNews(NewsDataSource):
    """美联储官方新闻数据源（RSS，标准库解析）"""

    def __init__(self):
        super().__init__("fed")

    def fetch_news(self, limit: int = 20) -> List[Dict[str, Any]]:
        """获取美联储官方新闻发布"""
        news_list = []

        try:
            client = self._get_client()

            url = "https://www.federalreserve.gov/feeds/press_all.xml"
            response = client.get(url, timeout=10.0)

            if response.status_code == 200:
                import xml.etree.ElementTree as ET
                root = ET.fromstring(response.content)

                for item in root.iter('item'):
                    title = (item.findtext('title') or '').strip()
                    if not title:
                        continue
                    # RSS 的 pubDate 形如 "Mon, 24 Aug 2026 12:30:00 -0400"
                    pub_date = item.findtext('pubDate')
                    published_at = None
                    if pub_date:
                        try:
                            dt = email.utils.parsedate_to_datetime(pub_date)
                            published_at = dt.astimezone().strftime('%Y-%m-%d %H:%M:%S')
                        except Exception:
                            pass
                    # description 可能含HTML标签，粗略剥离
                    desc = re.sub(r'<[^>]+>', '', item.findtext('description') or '').strip()
                    news_list.append({
                        'source': 'fed',
                        'title': title,
                        'content': desc[:500],
                        'url': (item.findtext('link') or '').strip(),
                        'published_at': published_at,
                        'country': 'us',
                        'event_type': 'monetary_policy',
                    })
                    if len(news_list) >= limit:
                        break

        except Exception as e:
            logger.warning(f"美联储新闻获取失败: {e}")

        return news_list


class SentimentMonitor:
    """舆情监控主类"""
    
    def __init__(self):
        """初始化舆情监控"""
        self.db = get_sentiment_db()
        self.filter = get_news_filter()
        self.analyzer = get_impact_analyzer()
        self.ws_manager = ws_manager
        
        # 数据源列表
        self.data_sources: List[NewsDataSource] = [
            EastMoneyNews(),
            SinaFinance(),
            FedReserveNews(),
        ]
        
        # 监控状态
        self.running = False
        self.monitor_task = None
    
    async def fetch_all_sources(self) -> List[Dict[str, Any]]:
        """获取所有数据源的舆情"""
        all_news = []
        
        for source in self.data_sources:
            try:
                # 在线程中执行HTTP请求，避免阻塞事件循环
                news_list = await asyncio.to_thread(source.fetch_news, limit=30)
                
                if news_list:
                    logger.info(f"{source.name} 获取到 {len(news_list)} 条新闻")
                    all_news.extend(news_list)
                else:
                    logger.debug(f"{source.name} 未获取到新闻")
            
            except Exception as e:
                logger.warning(f"{source.name} 数据获取异常: {e}")
        
        logger.info(f"总共获取到 {len(all_news)} 条舆情")
        return all_news
    
    async def process_news(self, news_list: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """处理舆情数据"""
        # 智能过滤
        important_news = self.filter.filter_important_news(news_list, min_score=60)
        
        # 关联分析（板块映射和个股匹配）
        for news in important_news:
            # 板块关联分析
            try:
                from sector_mapper import get_sector_mapper
                sector_mapper = get_sector_mapper()
                related_sectors = sector_mapper.identify_sectors_from_sentiment(news)
                news['related_sectors'] = related_sectors
                
                # 个股匹配
                from stock_matcher import get_stock_matcher  
                stock_matcher = get_stock_matcher()
                
                # 从标题和内容中匹配股票
                title_stocks = stock_matcher.match_stocks_in_text(news.get('title', ''))
                content_stocks = stock_matcher.match_stocks_in_text(news.get('content', ''))
                
                # 合并去重
                all_stocks = {}
                for stock in title_stocks + content_stocks:
                    stock_code = stock.get('stock_code')
                    if stock_code and stock_code not in all_stocks:
                        all_stocks[stock_code] = stock
                
                news['related_stocks'] = list(all_stocks.values())
                
            except Exception as e:
                logger.warning(f"关联分析失败: {e}")
                news['related_sectors'] = []
                news['related_stocks'] = []
        
        # 保存到数据库
        if important_news:
            saved_count = self.db.save_news(important_news)
            logger.info(f"保存了 {saved_count} 条重要舆情到数据库")
        
        return important_news
    
    async def broadcast_sentiment(self, news_list: List[Dict[str, Any]]):
        """通过WebSocket推送舆情"""
        if not news_list:
            return
        
        # 获取用户偏好模块
        try:
            from user_preference import get_user_preference
            user_preference = get_user_preference()
        except Exception as e:
            logger.warning(f"获取用户偏好模块失败: {e}")
            user_preference = None
        
        # 获取持仓优先模块
        try:
            from position_priority import get_position_priority
            position_priority = get_position_priority()
        except Exception as e:
            logger.warning(f"获取持仓优先模块失败: {e}")
            position_priority = None
        
        # 筛选需要推送的舆情
        push_list = []
        for news in news_list:
            # 检查用户是否应该接收此舆情推送
            should_push = True
            
            if user_preference:
                should_push = user_preference.should_push_notification(news)
            
            # 检查持仓关联（如果有持仓模块）
            if position_priority and should_push:
                position_relevance = position_priority.identify_position_relevance(news)
                if position_relevance.get('has_position_relevance'):
                    # 持仓相关舆情提高优先级
                    news['priority_boost'] = True
                    news['position_relevance'] = position_relevance
                else:
                    # 非持仓相关舆情，保持原有过滤逻辑
                    if news.get('importance_score', 0) < 80:
                        should_push = False
            
            if should_push:
                # 计算个性化评分
                if user_preference:
                    personalized_score = user_preference.calculate_personalized_score(news)
                    news['personalized_score'] = personalized_score
                
                push_list.append(news)
        
        if not push_list:
            logger.debug("没有符合推送条件的舆情")
            return
        
        # 按个性化评分排序
        push_list.sort(key=lambda x: x.get('personalized_score', x.get('importance_score', 0)), reverse=True)
        
        # 限制推送数量（每次最多推送5条）
        push_list = push_list[:5]
        
        # 通过WebSocket推送
        await ws_manager.broadcast({
            'type': 'sentiment_news',
            'data': push_list,
            'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        })
        
        logger.info(f"推送了 {len(push_list)} 条个性化舆情")

    async def monitor_loop(self, interval: int = 300):
        """舆情监控循环
        
        Args:
            interval: 监控间隔（秒），默认5分钟
        """
        logger.info(f"舆情监控循环启动，间隔: {interval}秒")
        self.running = True
        
        while self.running:
            try:
                # 获取舆情数据
                news_list = await self.fetch_all_sources()
                
                if news_list:
                    # 处理舆情
                    important_news = await self.process_news(news_list)
                    
                    # 推送高重要性舆情
                    await self.broadcast_sentiment(important_news)
                
                # 等待下一次监控
                await asyncio.sleep(interval)
            
            except Exception as e:
                logger.error(f"舆情监控循环异常: {e}")
                await asyncio.sleep(60)  # 出错后等待1分钟再重试
    
    def start(self, interval: int = 300):
        """启动舆情监控
        
        Args:
            interval: 监控间隔（秒）
        """
        if self.monitor_task and not self.monitor_task.done():
            logger.warning("舆情监控已经在运行")
            return
        
        self.monitor_task = asyncio.create_task(self.monitor_loop(interval))
        logger.info("舆情监控已启动")
    
    def stop(self):
        """停止舆情监控"""
        self.running = False
        if self.monitor_task:
            self.monitor_task.cancel()
            logger.info("舆情监控已停止")
    
    async def get_latest_sentiment(self, limit: int = 50, min_score: int = 60) -> List[Dict[str, Any]]:
        """获取最新舆情"""
        return await asyncio.to_thread(
            self.db.get_latest_news, limit, min_score
        )
    
    async def get_cn_sentiment(self, limit: int = 30) -> List[Dict[str, Any]]:
        """获取国内舆情"""
        return await asyncio.to_thread(
            self.db.get_by_country, 'cn', limit
        )
    
    async def get_us_sentiment(self, limit: int = 30) -> List[Dict[str, Any]]:
        """获取美国舆情"""
        return await asyncio.to_thread(
            self.db.get_by_country, 'us', limit
        )
    
    async def analyze_event_impact(
        self, 
        event: Dict[str, Any], 
        sectors: List[str]
    ) -> List[Dict[str, Any]]:
        """分析事件影响"""
        predictions = await asyncio.to_thread(
            self.analyzer.predict_impact,
            event.get('event_type', 'general'),
            event.get('description', ''),
            sectors,
            event.get('market_context')
        )
        
        # 转换为字典格式
        results = []
        for pred in predictions:
            results.append({
                'sector_name': pred.sector_name,
                'positive_probability': pred.positive_probability,
                'negative_probability': pred.negative_probability,
                'neutral_probability': pred.neutral_probability,
                'expected_value': pred.expected_value,
                'confidence': pred.confidence,
                'reasoning': pred.reasoning,
                'recommendation': pred.recommendation,
                'risk_scenarios': pred.risk_scenarios,
            })
        
        return results
    
    def cleanup(self):
        """清理资源"""
        # 关闭数据源连接
        for source in self.data_sources:
            source.close()
        
        # 关闭分析器连接
        if self.analyzer:
            self.analyzer.close()


# 全局实例
_sentiment_monitor = None


def get_sentiment_monitor() -> SentimentMonitor:
    """获取舆情监控全局实例"""
    global _sentiment_monitor
    if _sentiment_monitor is None:
        _sentiment_monitor = SentimentMonitor()
    return _sentiment_monitor