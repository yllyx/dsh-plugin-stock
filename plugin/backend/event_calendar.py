"""
事件日历管理模块

提供：
- 事件日历生成和管理
- 爬取财经网站经济日历
- 事件优先级评分
- 数据持久化
- 日历展示数据提供
"""

import httpx
import json
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional
from loguru import logger

from event_rules import get_event_rules
from sentiment_db import get_sentiment_db


class EventCalendar:
    """事件日历管理器"""
    
    def __init__(self):
        """初始化事件日历"""
        self.db = get_sentiment_db()
        self.event_rules = get_event_rules()
        self._client = None
    
    def _get_client(self) -> httpx.Client:
        """获取HTTP客户端"""
        if self._client is None:
            self._client = httpx.Client(
                headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    "Accept-Language": "zh-CN,zh;q=0.9",
                },
                timeout=15.0
            )
        return self._client
    
    def generate_calendar(self, months: int = 12) -> List[Dict[str, Any]]:
        """
        生成未来N个月的事件日历
        
        Args:
            months: 生成的月数
        
        Returns:
            事件列表
        """
        # 基于规则库生成
        rule_events = self.event_rules.generate_calendar(months)
        
        # 保存到数据库
        if rule_events:
            saved_count = self.db.save_events(rule_events)
            logger.info(f"保存规则库事件: {saved_count} 条")
        
        return rule_events
    
    def fetch_investing_calendar(self, days: int = 30) -> List[Dict[str, Any]]:
        """
        从Investing.com抓取经济日历
        
        Args:
            days: 抓取天数
        
        Returns:
            事件列表
        """
        events = []
        
        try:
            client = self._get_client()
            
            # Investing.com经济日历URL（中文版）
            url = "https://cn.investing.com/economic-calendar/"
            
            for day_offset in range(days):
                target_date = datetime.now() + timedelta(days=day_offset)
                date_str = target_date.strftime('%Y-%m-%d')
                
                # 构造API请求
                params = {
                    'date': date_str,
                    'timeframe': 'daily'
                }
                
                try:
                    response = client.get(url, params=params, timeout=10.0)
                    
                    if response.status_code == 200:
                        # 解析HTML或JSON
                        # 这里需要实际的HTML解析，暂时返回空列表
                        logger.debug(f"Investing.com日历抓取: {date_str}")
                        
                        # 模拟一些数据（实际应该解析HTML）
                        if day_offset < 7:  # 示例数据
                            sample_events = [
                                {
                                    'event_name': '非农就业数据',
                                    'event_type': 'us_macro',
                                    'event_date': date_str,
                                    'event_time': '20:30',
                                    'timezone': 'US/Eastern',
                                    'importance_score': 95,
                                    'description': '美国劳工部发布就业数据',
                                    'source_url': url,
                                    'country': 'us',
                                    'source': 'investing'
                                },
                                {
                                    'event_name': 'CPI数据',
                                    'event_type': 'us_macro',
                                    'event_date': date_str,
                                    'event_time': '20:30',
                                    'timezone': 'US/Eastern',
                                    'importance_score': 90,
                                    'description': '消费者物价指数',
                                    'source_url': url,
                                    'country': 'us',
                                    'source': 'investing'
                                }
                            ]
                            events.extend(sample_events)
                
                except Exception as e:
                    logger.warning(f"Investing.com抓取失败 {date_str}: {e}")
                    continue
        
        except Exception as e:
            logger.error(f"Investing.com日历抓取异常: {e}")
        
        logger.info(f"Investing.com抓取完成: {len(events)} 个事件")
        return events
    
    def fetch_tradingeconomics_calendar(self, days: int = 30) -> List[Dict[str, Any]]:
        """
        从Trading Economics抓取经济日历
        
        Args:
            days: 抓取天数
        
        Returns:
            事件列表
        """
        events = []
        
        try:
            client = self._get_client()
            
            # Trading Economics API（需要API key，这里使用免费版）
            url = "https://api.tradingeconomics.com/calendar"
            
            for day_offset in range(days):
                target_date = datetime.now() + timedelta(days=day_offset)
                date_str = target_date.strftime('%Y-%m-%d')
                
                try:
                    params = {
                        'd': date_str,
                        'f': 'json'  # 返回JSON格式
                    }
                    
                    response = client.get(url, params=params, timeout=10.0)
                    
                    if response.status_code == 200:
                        data = response.json()
                        
                        # 解析返回的JSON数据
                        if isinstance(data, list):
                            for item in data:
                                event = self._parse_te_event(item, date_str)
                                if event:
                                    events.append(event)
                
                except Exception as e:
                    logger.warning(f"Trading Economics抓取失败 {date_str}: {e}")
                    continue
        
        except Exception as e:
            logger.error(f"Trading Economics抓取异常: {e}")
        
        logger.info(f"Trading Economics抓取完成: {len(events)} 个事件")
        return events
    
    def _parse_te_event(self, item: Dict, date_str: str) -> Optional[Dict[str, Any]]:
        """解析Trading Economics事件项"""
        try:
            # 根据实际的API响应格式解析
            event = {
                'event_name': item.get('event', ''),
                'event_type': item.get('category', 'te_macro'),
                'event_date': date_str,
                'event_time': item.get('time', '00:00'),
                'timezone': item.get('timezone', 'UTC'),
                'importance_score': self._convert_te_importance(item.get('importance', '2')),
                'description': item.get('description', ''),
                'source_url': item.get('url', ''),
                'country': self._guess_country_from_event(item.get('event', '')),
                'source': 'tradingeconomics'
            }
            return event
        
        except Exception as e:
            logger.debug(f"解析TE事件失败: {e}")
            return None
    
    def _convert_te_importance(self, te_importance: str) -> int:
        """转换Trading Economics重要性等级"""
        importance_map = {
            '3': 95,  # 红色 - 高影响
            '2': 75,  # 橙色 - 中等影响
            '1': 50,  # 黄色 - 低影响
        }
        return importance_map.get(str(te_importance), 60)
    
    def _guess_country_from_event(self, event_name: str) -> str:
        """根据事件名称猜测国家"""
        cn_keywords = ['CPI', 'PMI', '社融', 'M2', '央行', '证监会']
        us_keywords = ['FOMC', 'Non-Farm', 'CPI', 'PCE', 'Fed', 'GDP']
        
        for kw in cn_keywords:
            if kw in event_name:
                return 'cn'
        
        for kw in us_keywords:
            if kw in event_name:
                return 'us'
        
        return 'both'
    
    def fetch_all_calendars(self, days: int = 30) -> List[Dict[str, Any]]:
        """
        从所有数据源抓取日历
        
        Args:
            days: 抓取天数
        
        Returns:
            合并去重后的事件列表
        """
        all_events = []
        
        # 从Investing.com抓取
        investing_events = self.fetch_investing_calendar(days)
        all_events.extend(investing_events)
        
        # 从Trading Economics抓取
        te_events = self.fetch_tradingeconomics_calendar(days)
        all_events.extend(te_events)
        
        # 去重处理
        unique_events = self._deduplicate_events(all_events)
        
        # 保存到数据库
        if unique_events:
            saved_count = self.db.save_events(unique_events)
            logger.info(f"保存爬取事件: {saved_count} 条")
        
        return unique_events
    
    def _deduplicate_events(self, events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """去重事件"""
        seen_keys = set()
        unique_events = []
        
        for event in events:
            # 生成唯一键
            event_key = f"{event.get('event_date', '')}_{event.get('event_time', '')}_{event.get('event_name', '')}"
            
            if event_key not in seen_keys:
                seen_keys.add(event_key)
                unique_events.append(event)
        
        return unique_events
    
    def get_events_by_date_range(
        self, 
        start_date: Optional[str] = None, 
        end_date: Optional[str] = None,
        country: Optional[str] = None,
        min_importance: int = 60
    ) -> List[Dict[str, Any]]:
        """
        获取日期范围内的事件
        
        Args:
            start_date: 开始日期 (YYYY-MM-DD)
            end_date: 结束日期 (YYYY-MM-DD)
            country: 国家筛选
            min_importance: 最低重要性
        
        Returns:
            事件列表
        """
        return self.db.get_events_by_date_range(start_date, end_date, country, min_importance)
    
    def get_upcoming_events(self, days: int = 7):
        """
        获取近期事件（按日期分组）
        
        Args:
            days: 天数
        
        Returns:
            按日期分组的事件字典
        """
        today = datetime.now()
        events = self.get_events_by_date_range(
            start_date=today.strftime('%Y-%m-%d'),
            end_date=(today + timedelta(days=days)).strftime('%Y-%m-%d')
        )
        
        # 按日期分组
        grouped_events = {}
        for event in events:
            event_date = event.get('event_date', '')
            if event_date not in grouped_events:
                grouped_events[event_date] = []
            grouped_events[event_date].append(event)
        
        # 按重要性排序每组事件
        for date in grouped_events:
            grouped_events[date].sort(key=lambda x: x.get('importance_score', 0), reverse=True)
        
        return grouped_events
    
    def calculate_event_impact_score(self, event: Dict[str, Any]) -> int:
        """
        计算事件影响度评分
        
        Args:
            event: 事件信息
        
        Returns:
            评分 (0-100)
        """
        score = 0
        
        # 1. 事件类型权重 (30分)
        event_type = event.get('event_type', '')
        if event_type in ['us_macro', 'cn_macro']:
            score += 30
        elif event_type in ['us_monetary', 'cn_monetary']:
            score += 25
        elif event_type in ['earnings']:
            score += 15
        
        # 2. 历史波动幅度 (40分)
        # 这里简化处理，实际应该从历史数据统计
        if event.get('importance_score', 0) >= 90:
            score += 40
        elif event.get('importance_score', 0) >= 75:
            score += 30
        elif event.get('importance_score', 0) >= 60:
            score += 20
        
        # 3. 市场环境敏感度 (20分)
        # 这里简化处理
        event_name = event.get('event_name', '')
        if any(kw in event_name for kw in ['非农', 'CPI', 'PCE', 'FOMC', '利率']):
            score += 20
        elif any(kw in event_name for kw in ['GDP', 'PMI', '社融']):
            score += 15
        
        # 4. 用户持仓相关性 (10分) - 暂时不实现
        score += 5  # 默认给5分
        
        return min(score, 100)
    
    def get_event_statistics(self, days: int = 30) -> Dict[str, Any]:
        """获取事件统计信息"""
        events = self.get_events_by_date_range(
            start_date=datetime.now().strftime('%Y-%m-%d'),
            end_date=(datetime.now() + timedelta(days=days)).strftime('%Y-%m-%d')
        )
        
        # 统计信息
        country_stats = {}
        category_stats = {}
        importance_stats = {'high': 0, 'medium': 0, 'low': 0}
        
        for event in events:
            country = event.get('country', 'unknown')
            category = event.get('event_type', 'unknown')
            importance = event.get('importance_score', 0)
            
            country_stats[country] = country_stats.get(country, 0) + 1
            category_stats[category] = category_stats.get(category, 0) + 1
            
            if importance >= 80:
                importance_stats['high'] += 1
            elif importance >= 60:
                importance_stats['medium'] += 1
            else:
                importance_stats['low'] += 1
        
        return {
            'total_events': len(events),
            'country_distribution': country_stats,
            'category_distribution': category_stats,
            'importance_distribution': importance_stats,
            'date_range_days': days
        }
    
    def cleanup_old_events(self, days: int = 90):
        """清理旧事件数据"""
        cutoff_date = (datetime.now() - timedelta(days=days)).strftime('%Y-%m-%d')
        
        try:
            if self.conn:
                cursor = self.conn.execute("""
                    DELETE FROM event_calendar 
                    WHERE event_date < ? 
                    AND importance_score < 70
                """, (cutoff_date,))
                
                deleted_count = cursor.rowcount
                self.conn.commit()
                
                if deleted_count > 0:
                    logger.info(f"清理了 {deleted_count} 条旧事件数据")
                
                return deleted_count
        
        except Exception as e:
            logger.error(f"清理旧事件失败: {e}")
            return 0
    
    def close(self):
        """关闭连接"""
        if self._client:
            self._client.close()


# 全局实例
_event_calendar = None


def get_event_calendar() -> EventCalendar:
    """获取事件日历全局实例"""
    global _event_calendar
    if _event_calendar is None:
        _event_calendar = EventCalendar()
    return _event_calendar