"""
板块映射和个股关联模块 v2

提供：
- 舆情关键词→板块映射（宏观硬编码方向 + 板块词库跟随舆情情感）
- 舆情板块名→东财真实板块(BK代码)桥接（SECTOR_BRIDGE + 动态排行匹配）
- 实时板块数据与龙头（复用 sector_monitor，含涨跌/动量/阶段/龙头打分）
- 投资建议生成（动态文案：具体板块名+实时数据+具体龙头）
"""

import time
from typing import List, Dict, Any, Optional
from loguru import logger

from sentiment_keywords import SentimentKeywords


# ============= 舆情板块名 → 东财真实板块名 桥接表 =============
# 候选按优先级排列；解析时与东财全量行业板块名做 精确→包含 匹配
SECTOR_BRIDGE: Dict[str, List[str]] = {
    # 十大分类
    "科技": ["半导体", "软件开发", "计算机设备", "通信设备", "消费电子", "IT服务", "互联网服务", "光学光电子", "电子元件"],
    "医药": ["化学制药", "医疗器械", "中药", "生物制品", "医疗服务", "医药商业"],
    "新能源": ["电池", "光伏设备", "风电设备", "电网设备", "电源设备", "能源金属"],
    "消费": ["食品饮料", "酿酒行业", "商业百货", "旅游酒店", "家用轻工", "农牧饲渔", "纺织服装"],
    "金融": ["证券", "银行", "保险"],
    "军工": ["航天航空", "船舶制造", "航空装备", "军工电子", "兵器兵装"],
    "周期": ["贵金属", "工业金属", "小金属", "煤炭行业", "钢铁行业", "化学原料", "化学制品", "石油行业", "化纤行业"],
    "地产": ["房地产开发", "房地产服务", "装修建材", "装修装饰"],
    "交运": ["航运港口", "物流行业", "铁路公路", "航空机场"],
    "传媒": ["游戏", "文化传媒", "互联网服务", "广告营销"],
    # 宏观映射产出的简称别名
    "黄金": ["贵金属"],
    "券商": ["证券"],
    "银行": ["银行"],
    "保险": ["保险"],
    "地产": ["房地产开发", "房地产服务"],
    "半导体": ["半导体"],
    "光伏": ["光伏设备"],
    "消费": ["食品饮料", "酿酒行业"],
    "食品饮料": ["食品饮料"],
    "白酒": ["酿酒行业"],
    "医药": ["化学制药", "医疗器械", "中药"],
    "机械": ["工程机械", "通用设备", "专用设备"],
    "电气": ["电网设备", "电源设备", "电机"],
    "有色金属": ["工业金属", "小金属", "能源金属"],
    "出口链": ["航运港口", "物流行业", "家用电器"],
    "出口": ["航运港口", "物流行业"],
    "汽车": ["汽车整车", "汽车零部件"],
    "AI": ["软件开发", "计算机设备", "互联网服务", "通信设备"],
    "人工智能": ["软件开发", "计算机设备", "互联网服务", "通信设备"],
    "芯片": ["半导体"],
    "锂电": ["电池", "能源金属"],
    "储能": ["电池", "电网设备"],
    "氢能": ["电池", "化学原料"],
    "核电": ["电网设备", "电源设备"],
    "风电": ["风电设备"],
    "创新药": ["生物制品", "化学制药"],
    "稀土": ["小金属"],
    "煤炭": ["煤炭行业"],
    "钢铁": ["钢铁行业"],
    "石油": ["石油行业"],
    "基建": ["工程建设", "装修建材", "工程机械"],
    "数字经济": ["软件开发", "计算机设备", "通信服务", "互联网服务"],
}

# 宏观关键词：方向硬编码（利好/利空逻辑不随舆情情感变化）
MACRO_MAPPINGS: Dict[str, List[Dict[str, Any]]] = {
    "降息": [
        {"sector": "地产", "impact": "positive", "weight": 0.9, "reasoning": "降低资金成本，利好地产"},
        {"sector": "券商", "impact": "positive", "weight": 0.8, "reasoning": "流动性改善"},
        {"sector": "银行", "impact": "negative", "weight": 0.6, "reasoning": "息差收窄"},
        {"sector": "黄金", "impact": "positive", "weight": 0.85, "reasoning": "美元走弱预期"},
    ],
    "加息": [
        {"sector": "银行", "impact": "positive", "weight": 0.7, "reasoning": "息差扩大"},
        {"sector": "地产", "impact": "negative", "weight": 0.9, "reasoning": "资金成本上升"},
        {"sector": "黄金", "impact": "negative", "weight": 0.8, "reasoning": "美元走强压制金价"},
    ],
    "美联储": [
        {"sector": "黄金", "impact": "neutral", "weight": 0.95, "reasoning": "货币政策直接影响"},
        {"sector": "有色金属", "impact": "neutral", "weight": 0.8, "reasoning": "美元相关性"},
    ],
    "FOMC": [
        {"sector": "黄金", "impact": "neutral", "weight": 0.95, "reasoning": "利率决议"},
        {"sector": "券商", "impact": "neutral", "weight": 0.7, "reasoning": "风险偏好影响"},
    ],
    "缩表": [
        {"sector": "黄金", "impact": "negative", "weight": 0.7, "reasoning": "流动性收紧"},
        {"sector": "券商", "impact": "negative", "weight": 0.7, "reasoning": "风险偏好下降"},
    ],
    "关税": [
        {"sector": "出口链", "impact": "negative", "weight": 0.85, "reasoning": "出口成本上升"},
        {"sector": "交运", "impact": "negative", "weight": 0.6, "reasoning": "贸易量受影响"},
    ],
    "制裁": [
        {"sector": "半导体", "impact": "negative", "weight": 0.85, "reasoning": "供应链受限"},
        {"sector": "军工", "impact": "positive", "weight": 0.7, "reasoning": "自主可控预期升温"},
    ],
    "集采": [
        {"sector": "医药", "impact": "negative", "weight": 0.85, "reasoning": "药品/器械价格下降"},
    ],
    "CPI": [
        {"sector": "消费", "impact": "neutral", "weight": 0.7, "reasoning": "通胀影响实际购买力"},
        {"sector": "黄金", "impact": "neutral", "weight": 0.7, "reasoning": "通胀预期影响金价"},
    ],
    "PMI": [
        {"sector": "机械", "impact": "neutral", "weight": 0.8, "reasoning": "制造业景气度直接相关"},
        {"sector": "周期", "impact": "neutral", "weight": 0.7, "reasoning": "工业需求风向标"},
    ],
}

# 板块关键词命中时跟随舆情情感的默认权重
_SECTOR_KW_WEIGHT = 0.75

_BRIDGE_CACHE_TTL = 300  # 板块名解析缓存5分钟


def _parse_pct(text: str) -> Optional[float]:
    """从 '换手18%活跃' 之类文案中提取百分比的辅助判断；无百分比返回None"""
    import re
    m = re.search(r'[+-]?\d+\.?\d*%', text)
    return float(m.group()[:-1]) if m else None


class SectorMapper:
    """板块映射引擎 v2"""

    def __init__(self):
        self._kw_lib = SentimentKeywords()
        # 板块词库: keyword -> category（从10大分类150词展开）
        self.sector_word_map: Dict[str, str] = {}
        for category, words in self._kw_lib.sector_keywords.items():
            for w in words:
                self.sector_word_map.setdefault(w, category)
        # 宏观关键词也并入总映射（优先级高于板块词库）
        self.macro_word_set = set(MACRO_MAPPINGS.keys())
        # 桥接缓存: 舆情板块名 -> (resolved_boards, timestamp)
        self._bridge_cache: Dict[str, Any] = {}
        # 全量行业板块名缓存
        self._all_boards_cache: Optional[Dict[str, Any]] = None

    # ---------- 关键词→板块识别 ----------

    def identify_sectors_from_sentiment(self, news: Dict[str, Any]) -> List[Dict[str, Any]]:
        """
        从舆情中识别相关板块。

        两类关键词：
        1. 宏观词（降息/CPI/FOMC等）：方向硬编码
        2. 板块词（150+词库）：方向跟随舆情情感标签
        """
        title = news.get('title', '') or ''
        content = news.get('content', '') or ''
        text = f"{title} {content}"
        sentiment_tag = news.get('sentiment_tag') or 'neutral'

        results: List[Dict[str, Any]] = []
        seen_sectors = set()
        matched_words: Dict[str, str] = {}  # sector -> 命中的词

        # 1. 宏观关键词（方向硬编码）
        for kw, mappings in MACRO_MAPPINGS.items():
            if kw in text:
                matched_words[kw] = kw
                for m in mappings:
                    if m['sector'] in seen_sectors:
                        continue
                    seen_sectors.add(m['sector'])
                    results.append({
                        'sector_name': m['sector'],
                        'impact': m['impact'],
                        'relevance': m['weight'],
                        'reasoning': m['reasoning'],
                        'match_type': 'macro',
                    })

        # 2. 板块词库（方向跟随情感）
        for word, category in self.sector_word_map.items():
            if word in text and category not in seen_sectors:
                seen_sectors.add(category)
                matched_words.setdefault(category, word)
                direction = sentiment_tag if sentiment_tag in ('positive', 'negative') else 'neutral'
                results.append({
                    'sector_name': category,
                    'impact': direction,
                    'relevance': _SECTOR_KW_WEIGHT,
                    'reasoning': f"舆情直接提及「{word}」",
                    'match_type': 'sector_word',
                })

        return results

    # ---------- 舆情板块名→东财真实板块 桥接 ----------

    def _get_all_industry_boards(self) -> List[Dict[str, Any]]:
        """东财全量行业板块（名称+当日涨跌），缓存5分钟。

        注意：接口默认按当日涨幅降序，max_count 必须 ≥ 板块总数，
        否则当日跌幅靠后的板块（可能正是目标板块）会被截掉。
        """
        if (self._all_boards_cache
                and time.time() - self._all_boards_cache['time'] < _BRIDGE_CACHE_TTL):
            return self._all_boards_cache['data']
        try:
            from eastmoney import get_board_rank
            boards = get_board_rank("industry", max_count=500) or []
            self._all_boards_cache = {'data': boards, 'time': time.time()}
            return boards
        except Exception as e:
            logger.warning(f"获取行业板块列表失败: {e}")
            return []

    def resolve_real_boards(self, sector_name: str, max_boards: int = 2) -> List[Dict[str, Any]]:
        """
        舆情板块名 → 东财真实板块（bk_code/name/change_pct）。
        候选顺序：SECTOR_BRIDGE别名表 → 板块名本身。
        匹配策略：精确 → 板块名包含候选 → 候选包含板块名。
        """
        cached = self._bridge_cache.get(sector_name)
        if cached and time.time() - cached['time'] < _BRIDGE_CACHE_TTL:
            return cached['data'][:max_boards]

        candidates = list(SECTOR_BRIDGE.get(sector_name, []))
        if sector_name not in candidates:
            candidates.append(sector_name)

        all_boards = self._get_all_industry_boards()
        resolved: List[Dict[str, Any]] = []
        used_codes = set()
        for cand in candidates:
            if len(resolved) >= max_boards:
                break
            hit = None
            # 精确
            for b in all_boards:
                if b['bk_code'] not in used_codes and b.get('name') == cand:
                    hit = b
                    break
            # 包含（双向）
            if hit is None:
                for b in all_boards:
                    if b['bk_code'] in used_codes:
                        continue
                    name = b.get('name') or ''
                    if cand in name or name in cand:
                        hit = b
                        break
            if hit:
                used_codes.add(hit['bk_code'])
                resolved.append({
                    'bk_code': hit['bk_code'],
                    'name': hit.get('name'),
                    'change_pct': hit.get('change_pct'),
                })

        self._bridge_cache[sector_name] = {'data': resolved, 'time': time.time()}
        if not resolved:
            logger.debug(f"板块桥接未命中: {sector_name} (候选: {candidates})")
        return resolved

    def enrich_sector_with_realtime(self, sector: Dict[str, Any], top_n_leaders: int = 3) -> Dict[str, Any]:
        """给识别出的板块附加东财实时数据（涨跌/动量/阶段/龙头）"""
        out = dict(sector)
        real_boards = self.resolve_real_boards(sector['sector_name'], max_boards=2)
        enriched_boards = []
        if real_boards:
            try:
                from sector_monitor import sector_monitor
                for rb in real_boards:
                    info = sector_monitor.get_board_realtime(rb['bk_code'], rb['name'], top_n=top_n_leaders)
                    info['sentiment_impact'] = sector.get('impact', 'neutral')
                    enriched_boards.append(info)
            except Exception as e:
                logger.warning(f"板块实时数据获取失败({sector['sector_name']}): {e}")
        out['real_boards'] = enriched_boards
        return out

    # ---------- 静态兜底（东财不可用时） ----------

    def extract_related_stocks(self, sector: str, max_count: int = 10, leaders_only: bool = False) -> List[Dict[str, Any]]:
        """静态板块成分兜底（仅当东财实时接口不可用时使用）"""
        from stock_matcher import SECTOR_FALLBACK_STOCKS
        stocks = SECTOR_FALLBACK_STOCKS.get(sector, [])
        if leaders_only:
            stocks = [s for s in stocks if s.get('is_leader', False)]
        return sorted(stocks, key=lambda x: x.get('weight', 0), reverse=True)[:max_count]

    def get_sector_statistics(self) -> Dict[str, Any]:
        return {
            'macro_keywords': len(MACRO_MAPPINGS),
            'sector_keywords': len(self.sector_word_map),
            'bridge_aliases': len(SECTOR_BRIDGE),
        }


# ============= 个股匹配 =============

class StockMatcher:
    """股票名称/代码匹配器"""

    def __init__(self):
        self.company_name_map = {
            "宁德时代": "300750", "比亚迪": "002594", "贵州茅台": "600519",
            "中芯国际": "688981", "隆基绿能": "601012", "药明康德": "603259",
            "恒瑞医药": "600276", "招商银行": "600036", "平安银行": "000001",
            "中国平安": "601318", "五粮液": "000858", "长江电力": "600900",
            "紫金矿业": "601899", "山东黄金": "600547", "中金黄金": "600489",
            "北方华创": "002371", "中微公司": "688012", "寒武纪": "688256",
            "海光信息": "688041", "立讯精密": "002475", "工业富联": "601138",
            "中际旭创": "300308", "新易盛": "300502", "浪潮信息": "000977",
            "中科曙光": "603019", "美的集团": "000333", "格力电器": "000651",
            "海尔智家": "600690", "万科A": "000002", "保利发展": "600048",
            "中信证券": "600030", "华泰证券": "601688", "东方财富": "300059",
            "中国石油": "601857", "中国石化": "600028", "中国神华": "601088",
            "陕西煤业": "601225", "三一重工": "600031", "恒立液压": "601100",
            "中国船舶": "600150", "中航沈飞": "600760", "汇川技术": "300124",
            "阳光电源": "300274", "通威股份": "600438", "天齐锂业": "002466",
            "赣锋锂业": "002460", "盐湖股份": "000792", "万华化学": "600309",
        }
        self.name_by_code = {v: k for k, v in self.company_name_map.items()}

    def match_stocks_in_text(self, text: str) -> List[Dict[str, Any]]:
        """从文本中匹配股票（公司名或6位代码）"""
        if not text:
            return []
        import re
        matched = []
        seen = set()
        for name, code in self.company_name_map.items():
            if name in text and code not in seen:
                matched.append({'code': code, 'name': name, 'match_type': 'direct_name', 'confidence': 0.95})
                seen.add(code)
        for m in re.finditer(r'\b([036]\d{5})\b', text):
            # 只匹配A股股票段：0深 3创 6沪；排除5开头的基金/ETF代码
            code = m.group(1)
            if code not in seen:
                matched.append({'code': code, 'name': self.name_by_code.get(code, code), 'match_type': 'code', 'confidence': 0.9})
                seen.add(code)
        return matched


# 静态板块成分兜底（东财接口不可用时；东财可用时一律用实时龙头）
SECTOR_FALLBACK_STOCKS: Dict[str, List[Dict[str, Any]]] = {
    "黄金": [
        {"code": "600547", "name": "山东黄金", "weight": 0.15, "is_leader": True},
        {"code": "601899", "name": "紫金矿业", "weight": 0.12, "is_leader": True},
    ],
    "半导体": [
        {"code": "688981", "name": "中芯国际", "weight": 0.12, "is_leader": True},
        {"code": "002371", "name": "北方华创", "weight": 0.10, "is_leader": True},
    ],
    "金融": [
        {"code": "600036", "name": "招商银行", "weight": 0.12, "is_leader": True},
        {"code": "600030", "name": "中信证券", "weight": 0.12, "is_leader": True},
    ],
    "消费": [
        {"code": "600519", "name": "贵州茅台", "weight": 0.18, "is_leader": True},
        {"code": "000858", "name": "五粮液", "weight": 0.12, "is_leader": True},
    ],
}


# ============= 投资建议（动态文案） =============

class InvestmentAdvisor:
    """基于实时板块/龙头数据生成具体投资建议"""

    def generate_investment_tip(
        self,
        sentiment: Dict[str, Any],
        related_stocks: List[Dict[str, Any]],
        enriched_sectors: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """
        Args:
            sentiment: 舆情（含 importance_score/sentiment_tag/title）
            related_stocks: 直接匹配的个股
            enriched_sectors: 已附加实时数据的板块（real_boards 含涨跌/动量/阶段/龙头）
        """
        importance = sentiment.get('importance_score', 60)
        sentiment_type = sentiment.get('sentiment_tag', 'neutral')
        enriched_sectors = enriched_sectors or []

        impact_analysis = self._analyze_impact(enriched_sectors, sentiment_type)
        recommended = self._filter_recommended_stocks(enriched_sectors, related_stocks, sentiment_type)
        operation_advice = self._generate_operation_advice(impact_analysis, enriched_sectors, recommended, importance)
        risk_warnings = self._generate_risk_warnings(enriched_sectors, importance)

        return {
            'sentiment_importance': importance,
            'sentiment_type': sentiment_type,
            'impact_analysis': impact_analysis,
            'recommended_stocks': recommended,
            'operation_advice': operation_advice,
            'risk_warnings': risk_warnings,
            'confidence': impact_analysis.get('confidence', 'low'),
        }

    def _analyze_impact(self, enriched_sectors: List[Dict[str, Any]], sentiment_type: str) -> Dict[str, Any]:
        """基于板块实时涨跌与舆情方向的一致性判定整体影响"""
        boards = []
        for sec in enriched_sectors:
            for rb in sec.get('real_boards', []):
                if rb.get('change_pct') is not None:
                    boards.append(rb)

        if not boards:
            return {
                'overall_impact': sentiment_type if sentiment_type != 'neutral' else 'neutral',
                'confidence': 'low',
                'description': '未匹配到实时板块数据，判断仅基于舆情情感',
            }

        expected = 'positive' if sentiment_type == 'positive' else 'negative' if sentiment_type == 'negative' else None
        if expected:
            agree = sum(1 for b in boards if (b['change_pct'] > 0) == (expected == 'positive'))
            ratio = agree / len(boards)
            overall = expected if ratio >= 0.5 else ('negative' if expected == 'positive' else 'positive')
            confidence = 'high' if ratio >= 0.75 else 'medium' if ratio >= 0.4 else 'low'
            desc_boards = '、'.join(f"{b['name']}{b['change_pct']:+.1f}%" for b in boards[:3])
            desc = f"涉及{len(boards)}个板块（{desc_boards}），其中{agree}个与舆情方向一致"
        else:
            up = sum(1 for b in boards if b['change_pct'] > 0)
            overall = 'positive' if up > len(boards) / 2 else 'negative' if up < len(boards) / 2 else 'neutral'
            confidence = 'medium'
            desc_boards = '、'.join(f"{b['name']}{b['change_pct']:+.1f}%" for b in boards[:3])
            desc = f"舆情中性，涉及板块今日表现：{desc_boards}"

        return {'overall_impact': overall, 'confidence': confidence, 'description': desc}

    def _filter_recommended_stocks(
        self,
        enriched_sectors: List[Dict[str, Any]],
        direct_stocks: List[Dict[str, Any]],
        sentiment_type: str,
    ) -> List[Dict[str, Any]]:
        """正面/中性舆情：真实龙头+直接命中个股；负面舆情：空（规避）"""
        if sentiment_type == 'negative':
            return []

        recommended: List[Dict[str, Any]] = []
        seen = set()

        # 1. 直接提及的个股优先
        for s in direct_stocks[:3]:
            code = s.get('code') or s.get('stock_code')
            if code and code not in seen:
                seen.add(code)
                recommended.append({
                    'code': code,
                    'name': s.get('name') or s.get('stock_name') or code,
                    'change_pct': None,
                    'score': None,
                    'reasons': ['舆情直接提及'],
                    'is_leader': False,
                    'sector_name': None,
                })

        # 2. 板块实时龙头（按板块情感方向过滤）
        for sec in enriched_sectors:
            if sec.get('impact') == 'negative':
                continue
            for rb in sec.get('real_boards', []):
                for ldr in rb.get('leaders', [])[:2]:
                    if ldr['code'] in seen:
                        continue
                    seen.add(ldr['code'])
                    recommended.append({
                        'code': ldr['code'],
                        'name': ldr['name'],
                        'change_pct': ldr.get('change_pct'),
                        'score': ldr.get('score'),
                        'reasons': ldr.get('reasons', []),
                        'is_leader': True,
                        'sector_name': rb.get('name'),
                    })

        return recommended[:5]

    def _fmt_leader(self, s: Dict[str, Any]) -> str:
        """格式化龙头：中芯国际(+4.2%,量比2.1放量)"""
        name = s['name']
        extras = []
        if s.get('change_pct') is not None:
            extras.append(f"{s['change_pct']:+.1f}%")
        # 跳过与涨幅重复的"今日+x%"类理由
        reasons = [r for r in (s.get('reasons') or [])
                   if r and not r.startswith('今日') and r != '涨停']
        if reasons:
            extras.append(reasons[0])
        elif s.get('change_pct') is not None and any(r == '涨停' for r in (s.get('reasons') or [])):
            extras.append('涨停')
        return f"{name}({','.join(extras)})" if extras else name

    def _generate_operation_advice(
        self,
        impact: Dict[str, Any],
        enriched_sectors: List[Dict[str, Any]],
        recommended: List[Dict[str, Any]],
        importance: int,
    ) -> str:
        """动态文案：具体板块名 + 实时数据 + 具体龙头"""
        overall = impact.get('overall_impact', 'neutral')

        # 取有实时数据的板块构造描述
        board_parts = []
        for sec in enriched_sectors:
            for rb in sec.get('real_boards', []):
                chg = rb.get('change_pct')
                mom = rb.get('momentum_5d')
                stage = rb.get('stage', '')
                seg = rb['name']
                if chg is not None:
                    seg += f"今日{chg:+.1f}%"
                if mom is not None:
                    seg += f"、5日动量{mom:+.1f}%"
                if stage and stage != '未知':
                    seg += f"（{stage}期）"
                board_parts.append(seg)
        board_desc = '、'.join(board_parts[:3])

        leader_desc = ''
        if recommended:
            tops = recommended[:3]
            leader_desc = '。关注：' + '、'.join(self._fmt_leader(s) for s in tops)

        if overall == 'positive' and board_parts:
            prefix = '利好' if importance >= 75 else '偏多'
            return f"{prefix}【{board_desc}】{leader_desc}。可跟踪板块龙头逢低参与，控制仓位"
        if overall == 'negative' and board_parts:
            return f"利空【{board_desc}】。建议规避相关板块，持仓者注意风险控制；等待企稳信号"
        if board_parts:
            return f"涉及板块【{board_desc}】方向尚不明确{leader_desc}。建议观望，待板块方向确认"
        return '舆情未匹配到具体板块，建议观望或结合自选股自行判断'

    def _generate_risk_warnings(self, enriched_sectors: List[Dict[str, Any]], importance: int) -> List[str]:
        warnings = []
        for sec in enriched_sectors:
            for rb in sec.get('real_boards', []):
                mom = rb.get('momentum_5d')
                stage = rb.get('stage')
                if stage == '高潮' and mom is not None and mom > 15:
                    warnings.append(f"板块【{rb['name']}】处于高潮期且5日动量{mom:+.1f}%，谨防追高与退潮风险")
                chg = rb.get('change_pct')
                if chg is not None and chg <= -3:
                    warnings.append(f"板块【{rb['name']}】今日已跌{chg:+.1f}%，注意持仓风险")
        if importance >= 90:
            warnings.append("极重要舆情，市场波动可能放大")
        return warnings[:4]


# ============= 全局实例 =============

_sector_mapper: Optional[SectorMapper] = None
_stock_matcher: Optional[StockMatcher] = None
_investment_advisor: Optional[InvestmentAdvisor] = None


def get_sector_mapper() -> SectorMapper:
    global _sector_mapper
    if _sector_mapper is None:
        _sector_mapper = SectorMapper()
    return _sector_mapper


def get_stock_matcher() -> StockMatcher:
    global _stock_matcher
    if _stock_matcher is None:
        _stock_matcher = StockMatcher()
    return _stock_matcher


def get_investment_advisor() -> InvestmentAdvisor:
    global _investment_advisor
    if _investment_advisor is None:
        _investment_advisor = InvestmentAdvisor()
    return _investment_advisor
