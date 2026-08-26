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
    
    def fetch_baidu_calendar(self, days: int = 30, include_past: int = 0) -> List[Dict[str, Any]]:
        """
        从百度股市通抓取真实经济日历（AKShare 生产同款接口，免费无鉴权）

        days: 未来天数
        include_past: 额外包含过去N天（进化闭环冷启动：拉历史事件供回填学习）
        """
        events: List[Dict[str, Any]] = []
        try:
            events = self._fetch_baidu_cate("economic_data", days, include_past=include_past)
            logger.info(f"百度经济日历抓取完成: {len(events)} 个事件")
        except Exception as e:
            logger.warning(f"百度经济日历抓取失败: {e}")

        report_events: List[Dict[str, Any]] = []
        if not include_past:
            try:
                report_events = self._fetch_baidu_cate("report_time", days, is_report=True)
                logger.info(f"百度财报日历抓取完成: {len(report_events)} 个事件")
            except Exception as e:
                logger.warning(f"百度财报日历抓取失败: {e}")

        all_events = self._deduplicate_events(events + report_events)

        # 板块名→东财BK代码解析 + 入库
        for ev in all_events:
            self._attach_bk_codes(ev)
        if all_events:
            saved = self.db.save_events(all_events)
            logger.info(f"百度日历入库: {saved} 条（真实数据，优先于规则推测）")
        return all_events

    def _fetch_baidu_cate(self, cate: str, days: int, is_report: bool = False, include_past: int = 0) -> List[Dict[str, Any]]:
        """抓取百度日历单个分类（单页即返回全量；空页/重复页终止）"""
        import time as _time
        start = (datetime.now() - timedelta(days=include_past)).strftime('%Y-%m-%d')
        end = (datetime.now() + timedelta(days=days)).strftime('%Y-%m-%d')

        url = "https://finance.pae.baidu.com/sapi/v1/financecalendar"
        raw_items: List[Dict[str, Any]] = []
        seen_keys = set()
        pn = 0
        while pn < 10:
            params = {
                "start_date": start,
                "end_date": end,
                "pn": pn,
                "rn": 100,
                "cate": cate,
                "finClientType": "pc",
            }
            data = self._baidu_request(url, params)
            result = (data or {}).get("Result") or {}
            info = result.get("calendarInfo") or []
            new_count = 0
            for day_block in info:
                for it in (day_block.get('list') or []):
                    if not isinstance(it, dict):
                        continue
                    key = f"{it.get('date','')}_{it.get('time','')}_{it.get('title','')}"
                    if key in seen_keys:
                        continue
                    seen_keys.add(key)
                    raw_items.append(it)
                    new_count += 1
            if new_count == 0:
                break  # 空页或重复页（单页已含全量数据）
            pn += 1
            _time.sleep(0.3)

        return [parsed for it in raw_items
                if (parsed := self._parse_baidu_item(it, is_report)) is not None]

    def _baidu_request(self, url: str, params: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """带Cookie流程的百度接口请求（先拿BAIDUID/HMACCOUNT再调API）"""
        client = self._get_client()
        base_headers = {
            "accept": "application/vnd.finance-web.v1+json",
            "referer": "https://finance.baidu.com/calendar",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        }
        cookie_parts = []
        page = None

        # 第一步：访问日历页拿 BAIDUID
        try:
            page = client.get("https://finance.baidu.com/calendar", headers={"User-Agent": base_headers["User-Agent"]}, timeout=10.0)
            for name in ("BAIDUID", "BAIDUID_BFESS"):
                v = page.cookies.get(name)
                if v:
                    cookie_parts.append(f"{name}={v}")
        except Exception as e:
            logger.debug(f"获取BAIDUID失败(可能仍可匿名请求): {e}")

        # 第二步：请求hm.js拿HMACCOUNT
        try:
            hm_url = "https://hm.baidu.com/hm.js"
            if page is not None:
                import re as _re
                m = _re.search(r'https://hm\.baidu\.com/hm\.js?[^\s"\']+pageURL[^\s"\']*', page.text)
                if m:
                    hm_url = m.group(0)
            resp = client.get(hm_url, headers={"User-Agent": base_headers["User-Agent"], "Referer": "https://finance.baidu.com/"}, timeout=8.0)
            hmaccount = resp.cookies.get("HMACCOUNT")
            if hmaccount:
                cookie_parts.append(f"HMACCOUNT={hmaccount}")
        except Exception as e:
            logger.debug(f"获取HMACCOUNT失败: {e}")

        headers = dict(base_headers)
        if cookie_parts:
            headers["Cookie"] = "; ".join(cookie_parts)

        resp = client.get(url, params=params, headers=headers, timeout=12.0)
        if resp.status_code != 200:
            raise RuntimeError(f"HTTP {resp.status_code}")
        return resp.json()

    # 重大事件标题加权（百度星级区分度不足：非农仅2星，用标题关键词校准）
    MAJOR_TITLE_BOOSTS = [
        ('非农就业人数变动', 95), ('FOMC', 95), ('利率决议', 95), ('联邦基金利率', 95),
        ('央行利率决议', 95), ('政治局', 90), ('中央经济工作', 90),
        ('核心CPI', 85), ('CPI年率', 82), ('PCE', 85), ('ISM制造业PMI', 85),
        ('GDP初值', 85), ('GDP年化', 80), ('ADP就业', 78), ('零售销售', 75),
        ('初请失业金', 72), ('PMI', 70),
        ('社会融资', 85), ('社融', 85), ('LPR', 88), ('MLF', 78), ('降准', 85),
        ('工业企业利润', 72), ('固定资产投资', 70), ('进出口', 75), ('贸易帐', 72),
    ]

    def _parse_baidu_item(self, item: Dict[str, Any], is_report: bool) -> Optional[Dict[str, Any]]:
        """解析百度日历事件项（字段: date/time/title/star/formerVal/pubVal/indicateVal/region/country）"""
        try:
            title = (item.get('title') or '').strip()
            date = (item.get('date') or '')[:10]
            if not title or not date:
                return None
            time_str = (item.get('time') or '')[:5] or '00:00'
            star = str(item.get('star') or '1').strip()
            importance = {'3': 92, '2': 72, '1': 50}.get(star, 55)
            # 标题关键词加权（星级不足时校准）
            for pattern, boost in self.MAJOR_TITLE_BOOSTS:
                if pattern in title:
                    importance = max(importance, boost)
                    break

            former = item.get('formerVal') or ''
            pub = item.get('pubVal') or ''
            indicate = item.get('indicateVal') or ''
            desc_parts = []
            if indicate:
                desc_parts.append(f"预期:{indicate}")
            if former:
                desc_parts.append(f"前值:{former}")
            if pub:
                desc_parts.append(f"公布:{pub}")
            if item.get('timePeriod'):
                desc_parts.append(str(item['timePeriod']))
            description = '，'.join(desc_parts)

            region = item.get('region') or item.get('country') or ''
            country = self._region_to_country(region, title)

            event_type = 'cn_report' if is_report else 'economic_data'
            if not is_report:
                from event_rules import map_title_to_sectors
                related = [{'sector_name': s, 'direction': 'neutral'} for s in map_title_to_sectors(title)]
            else:
                related = []

            return {
                'event_name': title,
                'event_type': event_type,
                'event_date': date,
                'event_time': time_str,
                'timezone': 'Asia/Shanghai',
                'importance_score': importance,
                'description': description,
                'country': country,
                'source_url': 'https://finance.baidu.com/calendar',
                'source': 'baidu',
                'is_estimated': False,   # 真实数据，非推测
                'related_sectors': related,
            }
        except Exception as e:
            logger.debug(f"解析百度日历事件失败: {e}")
            return None

    def _region_to_country(self, region: str, title: str) -> str:
        """百度地区名→国家代码"""
        region_map = {
            '美国': 'us', '中国': 'cn', '欧元区': 'eu', '日本': 'jp',
            '英国': 'gb', '德国': 'de', '法国': 'fr', '韩国': 'kr',
            '澳大利亚': 'au', '加拿大': 'ca', '印度': 'in', '俄罗斯': 'ru',
        }
        for name, code in region_map.items():
            if name in (region or '') or name in title:
                return code
        return 'other'

    def _attach_bk_codes(self, event: Dict[str, Any]):
        """给事件的related_sectors解析东财BK代码（缓存高效，失败静默）"""
        related = event.get('related_sectors') or []
        if not related:
            return
        try:
            from sector_mapper import get_sector_mapper
            mapper = get_sector_mapper()
            for sec in related:
                name = sec.get('sector_name')
                if name and not sec.get('bk_code'):
                    boards = mapper.resolve_real_boards(name, max_boards=1)
                    if boards:
                        sec['bk_code'] = boards[0]['bk_code']
                        sec['sector_real_name'] = boards[0]['name']
        except Exception as e:
            logger.debug(f"事件板块BK解析失败: {e}")

    def fetch_all_calendars(self, days: int = 30) -> List[Dict[str, Any]]:
        """从真实数据源（百度股市通）抓取日历"""
        return self.fetch_baidu_calendar(days)
    
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
            if self.db and self.db.conn:
                cursor = self.db.conn.execute("""
                    DELETE FROM event_calendar 
                    WHERE event_date < ? 
                    AND importance_score < 70
                """, (cutoff_date,))
                
                deleted_count = cursor.rowcount
                self.db.conn.commit()
                
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