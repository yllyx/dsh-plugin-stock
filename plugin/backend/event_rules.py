"""
事件日历规则库模块

提供：
- 重要经济事件发布时间规则（精确到分钟）
- 自动生成未来12个月事件日历
- 时区转换（EST ↔ CST）
- 事件类型和重要性分级
- 财报季时间表
"""

from datetime import datetime, timedelta, date
from typing import List, Dict, Any, Optional, Tuple
from dateutil.relativedelta import relativedelta
import pytz
from loguru import logger


class EventRules:
    """事件发布时间规则库"""
    
    def __init__(self):
        """初始化事件规则库"""
        self.cn_tz = pytz.timezone('Asia/Shanghai')
        self.us_tz = pytz.timezone('US/Eastern')
        self._build_event_rules()
    
    def _build_event_rules(self):
        """构建事件发布时间规则库"""
        self.EVENT_RULES = {
            # ==================== 美国经济数据 ====================
            "us_nonfarm": {
                "name": "美国非农就业报告",
                "name_en": "US Non-Farm Payrolls",
                "category": "us_economy",
                "importance": 100,  # 最高权重
                "schedule": {
                    "type": "monthly",
                    "day_of_week": "Friday",  # 每月第一个周五
                    "week": "first",
                    "time": "20:30",  # 美东时间，北京时间21:30/22:30(夏令时)
                    "timezone": "US/Eastern",
                },
                "impact_duration": 24,  # 影响市场24小时
                "keywords": ["非农", "就业", "失业率", "NFP"],
                "sources": ["bloomberg", "reuters", "wsj"],
                "country": "us",
            },
            
            "us_cpi": {
                "name": "美国CPI数据",
                "name_en": "US Consumer Price Index",
                "category": "us_economy",
                "importance": 95,
                "schedule": {
                    "type": "monthly",
                    "day_of_month": 10,  # 每月10-15日之间
                    "day_range": [10, 15],
                    "time": "20:30",
                    "timezone": "US/Eastern",
                },
                "keywords": ["CPI", "通胀", "物价指数"],
                "country": "us",
            },
            
            "us_pce": {
                "name": "美国PCE物价指数",
                "name_en": "US PCE Price Index",
                "category": "us_economy",
                "importance": 90,
                "schedule": {
                    "type": "monthly",
                    "day_of_month": 25,  # 每月25-30日
                    "day_range": [25, 30],
                    "time": "20:30",
                    "timezone": "US/Eastern",
                },
                "keywords": ["PCE", "核心PCE", "通胀"],
                "country": "us",
            },
            
            "us_fomc": {
                "name": "美联储FOMC议息会议",
                "name_en": "FOMC Meeting",
                "category": "us_monetary",
                "importance": 100,
                "schedule": {
                    "type": "yearly",
                    "dates": self._get_fomc_dates(2026),  # 2026年会议日期
                    "time": "14:00",  # 美东时间14:00，北京时间02:00/03:00(夏令时)
                    "timezone": "US/Eastern",
                },
                "keywords": ["美联储", "FOMC", "利率决议", "鲍威尔"],
                "country": "us",
            },
            
            "us_retail_sales": {
                "name": "美国零售销售",
                "name_en": "US Retail Sales",
                "category": "us_economy",
                "importance": 75,
                "schedule": {
                    "type": "monthly",
                    "day_of_month": 15,
                    "day_range": [13, 17],
                    "time": "20:30",
                    "timezone": "US/Eastern",
                },
                "keywords": ["零售", "消费", "零售销售"],
                "country": "us",
            },
            
            "us_gdp": {
                "name": "美国GDP数据",
                "name_en": "US GDP",
                "category": "us_economy",
                "importance": 80,
                "schedule": {
                    "type": "quarterly",
                    "month": [1, 4, 7, 10],  # 季度末月
                    "day_of_month": 25,
                    "day_range": [25, 30],
                    "time": "20:30",
                    "timezone": "US/Eastern",
                },
                "keywords": ["GDP", "经济增长"],
                "country": "us",
            },
            
            "us_adp": {
                "name": "美国ADP就业数据",
                "name_en": "US ADP Employment",
                "category": "us_economy",
                "importance": 65,
                "schedule": {
                    "type": "monthly",
                    "day_of_week": "Wednesday",
                    "week": "first",
                    "time": "20:15",
                    "timezone": "US/Eastern",
                },
                "keywords": ["ADP", "就业", "私人就业"],
                "country": "us",
            },
            
            "us_initial_jobless": {
                "name": "美国初请失业金",
                "name_en": "US Initial Jobless Claims",
                "category": "us_economy",
                "importance": 55,
                "schedule": {
                    "type": "weekly",
                    "day_of_week": "Thursday",
                    "time": "20:30",
                    "timezone": "US/Eastern",
                },
                "keywords": ["初请", "失业金", "初请失业金"],
                "country": "us",
            },
            
            # ==================== 国内经济数据 ====================
            "cn_cpi": {
                "name": "中国CPI数据",
                "category": "cn_economy",
                "importance": 85,
                "schedule": {
                    "type": "monthly",
                    "day_of_month": 9,
                    "day_range": [9, 12],
                    "time": "09:30",
                    "timezone": "Asia/Shanghai",
                },
                "keywords": ["CPI", "通胀", "物价"],
                "country": "cn",
            },
            
            "cn_pmi": {
                "name": "中国官方制造业PMI",
                "category": "cn_economy",
                "importance": 75,
                "schedule": {
                    "type": "monthly",
                    "day_of_month": 1,
                    "day_range": [1, 3],
                    "time": "09:00",
                    "timezone": "Asia/Shanghai",
                },
                "keywords": ["PMI", "制造业", "经济景气"],
                "country": "cn",
            },
            
            "cn_mlf": {
                "name": "MLF/LPR操作",
                "category": "cn_monetary",
                "importance": 90,
                "schedule": {
                    "type": "monthly",
                    "dates": [15, 20],  # MLF每月15日左右，LPR每月20日
                    "time": "09:00",
                    "timezone": "Asia/Shanghai",
                },
                "keywords": ["MLF", "LPR", "央行", "降息", "利率"],
                "country": "cn",
            },
            
            "cn_social_financing": {
                "name": "社融/M2数据",
                "category": "cn_economy",
                "importance": 80,
                "schedule": {
                    "type": "monthly",
                    "day_of_month": 10,
                    "day_range": [10, 15],
                    "time": "16:00",
                    "timezone": "Asia/Shanghai",
                },
                "keywords": ["社融", "M2", "信贷", "流动性"],
                "country": "cn",
            },
            
            "cn_fixed_asset": {
                "name": "固定资产投资",
                "category": "cn_economy",
                "importance": 70,
                "schedule": {
                    "type": "monthly",
                    "day_of_month": 15,
                    "day_range": [13, 17],
                    "time": "10:00",
                    "timezone": "Asia/Shanghai",
                },
                "keywords": ["固投", "投资", "基础设施"],
                "country": "cn",
            },
            
            "cn_industrial_profit": {
                "name": "工业企业利润",
                "category": "cn_economy",
                "importance": 65,
                "schedule": {
                    "type": "monthly",
                    "day_of_month": 27,
                    "day_range": [25, 30],
                    "time": "09:30",
                    "timezone": "Asia/Shanghai",
                },
                "keywords": ["工企利润", "工业企业", "利润"],
                "country": "cn",
            },
            
            # ==================== 国内重要会议 ====================
            "cn_two_sessions": {
                "name": "全国两会",
                "category": "cn_policy",
                "importance": 95,
                "schedule": {
                    "type": "yearly",
                    "dates": self._get_two_sessions_dates(2026),
                    "timezone": "Asia/Shanghai",
                },
                "keywords": ["两会", "人大", "政协", "GDP目标"],
                "country": "cn",
            },
            
            "cn_politburo": {
                "name": "中共中央政治局会议",
                "category": "cn_policy",
                "importance": 90,
                "schedule": {
                    "type": "quarterly",
                    "months": [4, 7, 10, 12],  # 通常每季度一次
                },
                "keywords": ["政治局", "政策", "经济工作"],
                "country": "cn",
            },
            
            "cn_state_council": {
                "name": "国务院常务会议",
                "category": "cn_policy",
                "importance": 75,
                "schedule": {
                    "type": "weekly",
                    "day_of_week": "Wednesday",
                    "timezone": "Asia/Shanghai",
                },
                "keywords": ["国常会", "国务院", "政策"],
                "country": "cn",
            },
            
            # ==================== 财报季 ====================
            "us_earnings_season": {
                "name": "美股财报季",
                "category": "earnings",
                "importance": 80,
                "schedule": {
                    "type": "quarterly",
                    "dates": [  # 财报季开始时间
                        "2026-01-15", "2026-04-15",
                        "2026-07-15", "2026-10-15"
                    ],
                    "duration_days": 45,  # 财报季持续约6周
                },
                "keywords": ["财报", "业绩", "营收"],
                "country": "us",
            },
            
            "cn_earnings_season": {
                "name": "A股财报季",
                "category": "earnings",
                "importance": 75,
                "schedule": {
                    "type": "quarterly",
                    "dates": [
                        "2026-01-15", "2026-04-30",
                        "2026-08-31", "2026-10-31"
                    ],
                },
                "keywords": ["年报", "季报", "业绩"],
                "country": "cn",
            },
            
            # ==================== 其他重要事件 ====================
            "blacklist_friday": {
                "name": "富时罗素/MSCI指数调整",
                "category": "market_event",
                "importance": 70,
                "schedule": {
                    "type": "monthly",
                    "week": "last",  # 每月最后一个周五
                    "day_of_week": "Friday",
                    "time": "19:00",
                    "timezone": "Europe/London",
                },
                "keywords": ["指数调整", "MSCI", "富时"],
                "country": "both",
            },
            
            "oil_output": {
                "name": "OPEC+石油产量会议",
                "category": "commodity",
                "importance": 85,
                "schedule": {
                    "type": "quarterly",
                    "months": [1, 4, 6, 9],  # 大致时间
                },
                "keywords": ["OPEC", "石油", "原油", "减产"],
                "country": "both",
            },
        }
    
    def _get_fomc_dates(self, year: int) -> List[str]:
        """获取FOMC会议日期"""
        # 2026年预计会议日期（基于历史规律）
        fomc_dates = {
            2026: ["2026-01-28", "2026-03-18", "2026-04-29",
                   "2026-06-16", "2026-07-27", "2026-09-21",
                   "2026-11-03", "2026-12-14"]
        }
        return fomc_dates.get(year, [])
    
    def _get_two_sessions_dates(self, year: int) -> List[str]:
        """获取两会日期"""
        # 2026年预计两会日期（3月第一周，持续7-10天）
        start_date = f"{year}-03-05"
        return [start_date, f"{year}-03-06", f"{year}-03-07", 
                f"{year}-03-08", f"{year}-03-09", f"{year}-03-10"]
    
    def generate_calendar(self, months: int = 12) -> List[Dict[str, Any]]:
        """
        生成未来N个月的日历
        
        Args:
            months: 生成的月数
        
        Returns:
            事件列表
        """
        calendar = []
        today = datetime.now(self.cn_tz)
        end_date = today + relativedelta(months=months)
        
        current_date = today.replace(hour=0, minute=0, second=0, microsecond=0)
        
        while current_date.date() <= end_date.date():
            # 检查每个事件规则
            for event_id, rule in self.EVENT_RULES.items():
                if self._should_event_occur(event_id, rule, current_date):
                    event = self._create_event(event_id, rule, current_date)
                    if event and self._is_future_event(event):
                        calendar.append(event)
            
            current_date += timedelta(days=1)
        
        # 按时间排序
        calendar.sort(key=lambda x: x['cn_time'])
        
        logger.info(f"生成事件日历: {len(calendar)} 个事件 (未来{months}个月)")
        return calendar
    
    def _should_event_occur(self, event_id: str, rule: Dict, check_date: datetime) -> bool:
        """判断事件是否在指定日期发生"""
        schedule = rule.get('schedule', {})
        
        if schedule.get('type') == 'monthly':
            return self._check_monthly_schedule(schedule, check_date)
        elif schedule.get('type') == 'yearly':
            return self._check_yearly_schedule(schedule, check_date)
        elif schedule.get('type') == 'quarterly':
            return self._check_quarterly_schedule(schedule, check_date)
        elif schedule.get('type') == 'weekly':
            return self._check_weekly_schedule(schedule, check_date)
        elif schedule.get('type') == 'irregular':
            return False  # 不定期事件通过爬取获取
        
        return False
    
    def _check_monthly_schedule(self, schedule: Dict, check_date: datetime) -> bool:
        """检查月度事件"""
        # 方式1: 指定日期范围
        if 'day_range' in schedule:
            day = check_date.day
            lo, hi = schedule['day_range']
            if 'day_of_month' in schedule:
                # 优先用名义发布日（夹在区间内），确保每月只生成一次
                target = max(lo, min(schedule['day_of_month'], hi))
                return day == target
            return lo <= day <= hi
        
        # 方式2: 指定第几个星期几
        if 'week' in schedule and 'day_of_week' in schedule:
            return self._is_nth_weekday(check_date, schedule['day_of_week'], schedule['week'])
        
        # 方式3: 固定日期列表
        if 'dates' in schedule:
            date_str = check_date.strftime('%Y-%m-%d')
            return date_str in schedule['dates']
        
        return False
    
    def _check_weekly_schedule(self, schedule: Dict, check_date: datetime) -> bool:
        """检查周度事件"""
        if 'day_of_week' in schedule:
            weekday_map = {
                'Monday': 0, 'Tuesday': 1, 'Wednesday': 2,
                'Thursday': 3, 'Friday': 4, 'Saturday': 5, 'Sunday': 6
            }
            target_weekday = weekday_map.get(schedule['day_of_week'])
            return check_date.weekday() == target_weekday
        
        return False
    
    def _check_yearly_schedule(self, schedule: Dict, check_date: datetime) -> bool:
        """检查年度事件"""
        if 'dates' in schedule:
            date_str = check_date.strftime('%Y-%m-%d')
            return date_str in schedule['dates']
        
        if 'months' in schedule:
            # 只在当月首日标记一次（如财报季开启）
            return check_date.month in schedule['months'] and check_date.day == 1

        return False
    
    def _check_quarterly_schedule(self, schedule: Dict, check_date: datetime) -> bool:
        """检查季度事件"""
        # 检查月份
        if 'month' in schedule:
            if check_date.month not in schedule['month']:
                return False
        
        # 检查日期范围
        if 'day_range' in schedule:
            day = check_date.day
            lo, hi = schedule['day_range']
            if 'day_of_month' in schedule:
                # 优先名义发布日，每季度只生成一次
                target = max(lo, min(schedule['day_of_month'], hi))
                return day == target
            return lo <= day <= hi

        # 检查特定日期
        if 'dates' in schedule:
            date_str = check_date.strftime('%Y-%m-%d')
            return date_str in schedule['dates']

        # 季度末月检查（默认只在名义日生成，避免整月重复）
        if check_date.month not in [1, 4, 7, 10]:
            return False

        if 'day_of_month' in schedule:
            return check_date.day == schedule['day_of_month']

        return check_date.day == 25
    
    def _is_nth_weekday(self, date: datetime, day_name: str, week_num: str) -> bool:
        """判断是否为第N个星期X"""
        weekday_map = {
            'Monday': 0, 'Tuesday': 1, 'Wednesday': 2,
            'Thursday': 3, 'Friday': 4, 'Saturday': 5, 'Sunday': 6
        }
        
        target_weekday = weekday_map.get(day_name)
        if date.weekday() != target_weekday:
            return False
        
        # 计算是本月第几个该星期几
        day = date.day
        if week_num == 'first':
            return 1 <= day <= 7
        elif week_num == 'last':
            return day >= 21
        elif week_num in ['second', 'third', 'fourth']:
            week_num_map = {'second': 2, 'third': 3, 'fourth': 4}
            n = week_num_map[week_num]
            return (n-1)*7 < day <= n*7
        
        return False
    
    def _create_event(self, event_id: str, rule: Dict, check_date: datetime) -> Optional[Dict[str, Any]]:
        """创建事件对象"""
        try:
            schedule = rule.get('schedule', {})
            time_str = schedule.get('time', '00:00')
            timezone_name = schedule.get('timezone', 'Asia/Shanghai')

            # 获取时区
            tz = pytz.timezone(timezone_name)

            # pytz.localize 要求 naive datetime，先剥离可能存在的 tzinfo
            naive_date = check_date.replace(tzinfo=None) if check_date.tzinfo else check_date

            # 创建事件时间
            try:
                hour, minute = map(int, time_str.split(':'))
                event_datetime = naive_date.replace(hour=hour, minute=minute)
                localized_time = tz.localize(event_datetime)
            except:
                # 如果时间解析失败，使用默认时间
                localized_time = tz.localize(naive_date.replace(hour=0, minute=0))
            
            # 转换到北京时间
            cn_datetime = localized_time.astimezone(self.cn_tz)
            
            # 判断是否是未来事件
            if cn_datetime < datetime.now(self.cn_tz):
                return None  # 过去事件不生成
            
            return {
                'id': f"{event_id}_{check_date.strftime('%Y%m%d')}",
                'event_id': event_id,
                'name': rule['name'],
                'name_en': rule.get('name_en', ''),
                'category': rule['category'],
                'importance_score': rule.get('importance', 70),
                'event_date': cn_datetime.strftime('%Y-%m-%d'),
                'event_time': cn_datetime.strftime('%H:%M'),
                'timezone': timezone_name,
                'original_time': time_str,
                'keywords': rule.get('keywords', []),
                'source': 'rule',  # 标记来源
                'country': rule.get('country', 'cn'),
                'cn_time': cn_datetime.isoformat(),
                'days_until': (cn_datetime.date() - datetime.now(self.cn_tz).date()).days,
                'description': self._generate_event_description(rule, cn_datetime),
            }
        
        except Exception as e:
            logger.debug(f"创建事件失败: {e}, 事件: {event_id}")
            return None
    
    def _is_future_event(self, event: Dict[str, Any]) -> bool:
        """判断是否是未来事件"""
        try:
            cn_time_str = event.get('cn_time', '')
            cn_time = datetime.fromisoformat(cn_time_str.replace('Z', '+00:00'))
            return cn_time > datetime.now(self.cn_tz)
        except:
            return False
    
    def _generate_event_description(self, rule: Dict, event_time: datetime) -> str:
        """生成事件描述"""
        base_desc = rule['name']
        
        # 添加发布时间
        time_str = event_time.strftime('%H:%M')
        date_str = event_time.strftime('%m月%d日')
        
        # 添加重要性标识
        importance = rule.get('importance', 70)
        if importance >= 90:
            importance_tag = '【极重要】'
        elif importance >= 80:
            importance_tag = '【重要】'
        else:
            importance_tag = ''
        
        return f"{importance_tag}{base_desc} ({date_str} {time_str})"
    
    def update_fomc_dates(self, year: int, new_dates: List[str]):
        """更新特定事件的日期（如FOMC会议日期）"""
        event_id = "us_fomc"
        if event_id in self.EVENT_RULES and 'schedule' in self.EVENT_RULES[event_id]:
            self.EVENT_RULES[event_id]['schedule']['dates'] = new_dates
            logger.info(f"更新{year}年FOMC会议日期: {new_dates}")
    
    def get_event_by_id(self, event_id: str) -> Optional[Dict[str, Any]]:
        """根据事件ID获取规则"""
        return self.EVENT_RULES.get(event_id)
    
    def get_all_rules(self) -> Dict[str, Dict[str, Any]]:
        """获取所有事件规则"""
        return self.EVENT_RULES
    
    def get_statistics(self) -> Dict[str, Any]:
        """获取规则统计信息"""
        total_rules = len(self.EVENT_RULES)
        
        category_stats = {}
        importance_stats = {'high': 0, 'medium': 0, 'low': 0}
        country_stats = {'us': 0, 'cn': 0, 'both': 0}
        
        for event_id, rule in self.EVENT_RULES.items():
            category = rule.get('category', 'unknown')
            category_stats[category] = category_stats.get(category, 0) + 1
            
            importance = rule.get('importance', 70)
            if importance >= 80:
                importance_stats['high'] += 1
            elif importance >= 60:
                importance_stats['medium'] += 1
            else:
                importance_stats['low'] += 1
            
            country = rule.get('country', 'cn')
            country_stats[country] = country_stats.get(country, 0) + 1
        
        return {
            'total_rules': total_rules,
            'category_distribution': category_stats,
            'importance_distribution': importance_stats,
            'country_distribution': country_stats,
        }


# 全局实例
_event_rules = None


def get_event_rules() -> EventRules:
    """获取事件规则库全局实例"""
    global _event_rules
    if _event_rules is None:
        _event_rules = EventRules()
    return _event_rules