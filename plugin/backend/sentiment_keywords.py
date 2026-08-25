"""
核心关键词库模块

提供：
- 预设专业关键词库（200+关键词）
- 关键词分类和权重体系
- 重要性评分算法
- 时效性加成机制
- 板块映射关系
"""

from typing import Dict, List, Any, Optional
from datetime import datetime, timedelta


class SentimentKeywords:
    """舆情关键词库管理"""
    
    def __init__(self):
        """初始化关键词库"""
        self.core_keywords = self._build_core_keywords()
        self.sector_keywords = self._build_sector_keywords()
        self.synonym_mappings = self._build_synonym_mappings()
        self.seasonal_keywords = self._build_seasonal_keywords()
    
    def _build_core_keywords(self) -> Dict[str, Dict[str, Any]]:
        """构建核心关键词库"""
        return {
            # ==================== 美国经济数据 ====================
            "us_economy": {
                "name": "美国经济数据",
                "keywords": [
                    # 利率/货币政策
                    "美联储", "FOMC", "利率决议", "降息", "加息", "利率", "鲍威尔",
                    "联邦基金利率", "点阵图", "量化宽松", "QT", "缩表", "前瞻指引",
                    
                    # 就业数据
                    "非农", "非农就业", "失业率", "初请失业金", "续请失业金",
                    "ADP就业", "JOLTS", "职位空缺", "薪资增长", "平均时薪",
                    
                    # 通胀数据
                    "CPI", "消费者物价指数", "PCE", "核心PCE", "PPI",
                    "生产者物价指数", "通胀", "通缩", "通胀预期", "通胀率",
                    
                    # 经济增长
                    "GDP", "国内生产总值", "零售销售", "消费者信心", "PMI",
                    "制造业PMI", "服务业PMI", "工业产出", "耐用品订单", "工厂订单",
                    
                    # 房地产数据
                    "成屋销售", "新屋开工", "营建许可", "房价指数", "S&P/CS",
                    "房屋开工", "建筑许可",
                    
                    # 消费和商业
                    "消费者支出", "个人收入", "个人储蓄率", "信用卡债务",
                    "商业库存", "批发库存",
                ],
                "importance": 90,
                "category": "macro",
                "country": "us",
                "sources": ["fed", "bls", "bea", "reuters", "bloomberg"],
            },
            
            # ==================== 中美贸易/科技 ====================
            "trade_tech": {
                "name": "中美贸易/科技",
                "keywords": [
                    # 贸易争端
                    "贸易战", "关税", "加征关税", "关税豁免", "301调查",
                    "实体清单", "制裁", "解除制裁", "出口管制", "投资禁令",
                    "新疆法案", "军工企业",
                    
                    # 科技限制
                    "芯片", "半导体", "光刻机", "AI芯片", "GPU禁令",
                    "先进制程", "技术封锁", "科技竞争", "技术转让",
                    "断供", "禁售", "技术壁垒",
                    
                    # 受影响公司
                    "华为", "中芯国际", "大疆", "海康威视", "科大讯飞",
                    "tiktok", "字节跳动", "腾讯", "阿里巴巴",
                    
                    # 中概股相关
                    "中概股", "VIE架构", "审计底稿", "退市风险", "PCAOB",
                    "外国公司问责法", "预摘牌",
                ],
                "importance": 95,
                "category": "policy",
                "country": "both",
                "sources": ["all"],
            },
            
            # ==================== 国内政策 ====================
            "cn_policy": {
                "name": "国内政策",
                "keywords": [
                    # 货币政策
                    "央行", "降准", "降息", "LPR", "MLF", "逆回购",
                    "流动性", "社融", "M2", "信贷投放", "公开市场操作",
                    "货币供应量", "宏观数据",
                    
                    # 财政政策
                    "财政政策", "减税降费", "专项债", "国债", "赤字率",
                    "政府债券", "财政赤字", "税收政策", "增值税",
                    
                    # 资本市场政策
                    "证监会", "IPO", "再融资", "减持", "回购", "分红",
                    "退市", "注册制", "转融通", "量化交易", "程序化交易",
                    "融券", "做空", "股东减持", "限售股", "大股东",
                    
                    # 房地产政策
                    "限购", "限贷", "首付比例", "房贷利率", "公积金",
                    "保交楼", "房企融资", "三支箭", "房地产",
                    
                    # 监管政策
                    "反垄断", "平台经济", "数据安全", "网络安全", "个人信息",
                    "教育培训", "双减", "游戏版号",
                ],
                "importance": 85,
                "category": "policy",
                "country": "cn",
                "sources": ["pbc", "csrc", "mof", "eastmoney", "caixin"],
            },
            
            # ==================== 市场情绪 ====================
            "market_sentiment": {
                "name": "市场情绪",
                "keywords": [
                    "牛市", "熊市", "反弹", "跳水", "暴涨", "暴跌",
                    "成交额", "成交量", "换手率", "涨停", "跌停",
                    "炸板", "封板", "开板", "地天板", "天地板",
                    "北向资金", "南向资金", "外资", "内资", "游资",
                    "抱团", "瓦解", "轮动", "主线", "题材", "热点",
                    "赚钱效应", "亏钱效应", "恐慌", "贪婪", "避险",
                ],
                "importance": 60,
                "category": "market",
                "country": "both",
                "sources": ["all"],
            },
            
            # ==================== 财报季 ====================
            "earnings": {
                "name": "财报季",
                "keywords": [
                    "财报", "业绩", "营收", "利润", "EPS", "净利润",
                    "毛利率", "净利率", "ROE", "ROA", "ROIC",
                    "业绩指引", "超预期", "不及预期", "同比", "环比",
                    "季报", "年报", "中报", "一季报", "三季报",
                    "业绩预告", "业绩快报", "业绩修正",
                    "营收增长", "利润增长", "业绩改善", "业绩下滑",
                ],
                "importance": 70,
                "category": "earnings",
                "country": "both",
                "sources": ["all"],
                "seasonal": True,  # 财报季期间自动提升权重
            },
            
            # ==================== 黑天鹅事件 ====================
            "black_swan": {
                "name": "黑天鹅事件",
                "keywords": [
                    # 公司风险
                    "破产", "倒闭", "违约", "暴雷", "造假", "欺诈",
                    "调查", "立案", "处罚", "罚款", "停牌", "退市",
                    "财务造假", "虚增利润", "隐瞒债务", "关联交易",
                    
                    # 市场风险
                    "战争", "地缘政治", "恐怖袭击", "自然灾害", "疫情",
                    "封控", "封锁", "熔断", "崩盘", "股灾", "金融风暴",
                    
                    # 政策风险
                    "政策突变", "监管收紧", "整治", "清退", "取缔",
                    
                    # 技术风险
                    "系统故障", "技术故障", "交易中断", "数据错误",
                ],
                "importance": 100,  # 最高优先级
                "category": "risk",
                "country": "both",
                "sources": ["all"],
            },
            
            # ==================== 特殊事件类型 ====================
            "IPO相关": {
                "name": "IPO相关",
                "keywords": [
                    "申购", "打新", "中签率", "上市", "挂牌",
                    "新股", "IPO上市", "首发", "破发", "首日涨幅",
                    "新股发行", "融资额", "募资", "超募",
                ],
                "importance": 50,
                "category": "market",
                "country": "both",
                "sources": ["all"],
            },
            
            "分红派息": {
                "name": "分红派息",
                "keywords": [
                    "分红", "派息", "股息", "股息率", "分红率",
                    "股权登记日", "除权除息日", "派息日", "现金分红",
                    "股票分红", "送股", "转增", "高分红",
                ],
                "importance": 45,
                "category": "market",
                "country": "both",
                "sources": ["all"],
            },
            
            "限售股解禁": {
                "name": "限售股解禁",
                "keywords": [
                    "解禁", "限售股", "首发原股东限售", "定增限售",
                    "解禁市值", "解禁比例", "大额解禁", "减持压力",
                    "股份解禁", "流通盘",
                ],
                "importance": 55,
                "category": "market",
                "country": "cn",
                "sources": ["eastmoney", "sina"],
            },
        }
    
    def _build_sector_keywords(self) -> Dict[str, List[str]]:
        """构建板块关键词库"""
        return {
            "科技": [
                "芯片", "半导体", "AI", "人工智能", "算力", "CPO", "光模块",
                "5G", "6G", "物联网", "云计算", "数据中心", "服务器",
                "操作系统", "数据库", "办公软件", "工业软件", "网络安全",
                "消费电子", "智能硬件", "VR", "AR", "元宇宙",
            ],
            "医药": [
                "集采", "创新药", "医保", "疫苗", "中药", "CRO",
                "医疗器械", "生物药", "PD-1", "GLP-1", "胰岛素",
                "仿制药", "化学药", "医疗服务", "互联网医疗",
            ],
            "新能源": [
                "光伏", "风电", "锂电池", "储能", "新能源车", "充电桩",
                "特高压", "智能电网", "氢能", "核电", "碳中和",
                "锂电材料", "隔膜", "电解液", "正极材料", "负极材料",
            ],
            "消费": [
                "白酒", "免税", "电商", "旅游", "酒店", "餐饮",
                "化妆品", "家电", "零售", "预制菜", "品牌消费",
                "食品饮料", "调味品", "休闲食品", "猪肉价格",
            ],
            "金融": [
                "银行", "券商", "保险", "信托", "租赁", "AMC",
                "利率", "息差", "不良率", "资本充足率", "券商股",
                "保险股", "信托", "期货", "资产管理",
            ],
            "军工": [
                "军工", "导弹", "卫星", "雷达", "无人机", "发动机",
                "军用电子", "导弹防御", "军民融合", "国防军工",
                "航空航天", "兵器", "舰船",
            ],
            "周期": [
                "煤炭", "钢铁", "有色", "化工", "水泥", "玻璃",
                "石油", "天然气", "造纸", "航运", "港口",
                "有色金属", "稀土", "钴锂", "钛白粉",
            ],
            "地产": [
                "地产", "房地产", "住房", "房企", "物业公司",
                "建筑装饰", "建筑材料", "家居", "装饰装修",
            ],
            "交运": [
                "快递", "物流", "航空", "机场", "高速", "港口",
                "铁路", "公路", "航运", "集装箱",
            ],
            "传媒": [
                "游戏", "影视", "广告", "出版", "教育", "体育",
                "短视频", "直播", "社交媒体", "内容平台",
            ],
        }
    
    def _build_synonym_mappings(self) -> Dict[str, List[str]]:
        """构建同义词映射"""
        return {
            "降息": ["宽松", "鸽派", "降准", "流动性宽松", "货币宽松"],
            "加息": ["收紧", "鹰派", "缩表", "货币紧缩"],
            "美联储": ["FOMC", "鲍威尔", "美联储主席", "联储"],
            "非农": ["非农就业", "就业报告", "就业数据", "新增就业"],
            "CPI": ["通胀", "物价指数", "消费者物价", "通胀率"],
            "PCE": ["核心PCE", "个人消费支出"],
            "GDP": ["国内生产总值", "经济增长", "经济总量"],
            "PMI": ["制造业PMI", "服务业PMI", "采购经理指数"],
            "社融": ["社会融资", "社融规模", "新增社融"],
            "央行": ["人民银行", "人行", "中国央行"],
            "证监会": ["监管层", "监管层", "证券会"],
            "芯片": ["半导体", "集成电路", "IC"],
            "新能源车": ["电动汽车", "电动车", "EV"],
            "人工智能": ["AI", "机器学习", "深度学习"],
        }
    
    def _build_seasonal_keywords(self) -> Dict[str, List[str]]:
        """构建时效性关键词（根据日历自动激活）"""
        return {
            "1月": ["年报预告", "年报披露", "业绩快报", "春节效应", "开工率", "春运"],
            "2月": ["春节效应", "开工率", "春运", "两会预热"],
            "3月": ["两会", "GDP目标", "预算案", "政府工作报告"],
            "4月": ["一季报", "年报", "分红预案", "业绩说明会"],
            "5月": ["消费复苏", "旅游数据", "五一小长假"],
            "6月": ["半年报预告", "年中考核", "半年总结"],
            "7月": ["半年报", "中报业绩", "中报披露"],
            "8月": ["半年报披露", "消费旺季", "金九银十预热"],
            "9月": ["三季度", "消费旺季", "金九银十", "中秋节"],
            "10月": ["三季报", "国庆数据", "黄金周", "三季度财报"],
            "11月": ["进博会", "购物节", "双11", "双十一"],
            "12月": ["中央经济工作会议", "年度总结", "展望明年"],
        }
    
    def get_keywords_by_importance(self, min_importance: int = 60) -> Dict[str, List[str]]:
        """根据重要性获取关键词"""
        result = {}
        for category, data in self.core_keywords.items():
            if data.get('importance', 0) >= min_importance:
                result[category] = data['keywords']
        return result
    
    def get_sector_keywords(self, sector: str) -> List[str]:
        """获取特定板块的关键词"""
        return self.sector_keywords.get(sector, [])
    
    def expand_synonyms(self, keyword: str) -> List[str]:
        """扩展关键词同义词"""
        synonyms = [keyword]
        
        for main_word, syn_list in self.synonym_mappings.items():
            if keyword in syn_list:
                synonyms.append(main_word)
                synonyms.extend(syn_list)
            elif keyword == main_word:
                synonyms.extend(syn_list)
        
        return list(set(synonyms))
    
    def get_seasonal_keywords(self, month: Optional[int] = None) -> List[str]:
        """获取时效性关键词"""
        if month is None:
            month = datetime.now().month
        
        month_key = f"{month}月"
        return self.seasonal_keywords.get(month_key, [])
    
    def calculate_keyword_score(
        self, 
        keyword: str, 
        category: str,
        hours_old: int = 0
    ) -> int:
        """
        计算关键词重要性评分
        
        Args:
            keyword: 关键词
            category: 关键词分类
            hours_old: 舆情发布时间（小时）
        
        Returns:
            重要性评分 (0-100)
        """
        base_score = 0
        
        # 1. 基础分类分数
        if category in self.core_keywords:
            base_score = self.core_keywords[category].get('importance', 50)
        
        # 2. 关键词具体匹配分数
        for cat_name, cat_data in self.core_keywords.items():
            if keyword in cat_data['keywords']:
                base_score = max(base_score, cat_data.get('importance', 50))
        
        # 3. 时效性加成
        time_bonus = 0
        if hours_old < 1:
            time_bonus = 20  # 1小时内
        elif hours_old < 6:
            time_bonus = 15  # 6小时内
        elif hours_old < 24:
            time_bonus = 10  # 24小时内
        elif hours_old < 72:
            time_bonus = 5   # 3天内
        
        # 4. 特殊加成
        special_bonus = 0
        if category == "black_swan":
            special_bonus = 10  # 黑天鹅事件额外加成
        elif category == "earnings":
            current_month = datetime.now().month
            # 财报季期间（1月、4月、7月、10月）加成
            if current_month in [1, 4, 7, 10]:
                special_bonus = 15
        
        total_score = base_score + time_bonus + special_bonus
        
        return min(total_score, 100)  # 确保不超过100分
    
    def get_all_keywords(self) -> Dict[str, List[str]]:
        """获取所有关键词"""
        all_keywords = {}
        
        # 核心关键词
        for category, data in self.core_keywords.items():
            all_keywords[category] = data['keywords']
        
        # 板块关键词
        for sector, keywords in self.sector_keywords.items():
            all_keywords[f"sector_{sector}"] = keywords
        
        return all_keywords
    
    def get_keyword_info(self, keyword: str) -> Optional[Dict[str, Any]]:
        """获取关键词详细信息"""
        for category, data in self.core_keywords.items():
            if keyword in data['keywords']:
                return {
                    'keyword': keyword,
                    'category': category,
                    'name': data.get('name', category),
                    'importance': data.get('importance', 50),
                    'category_type': data.get('category', 'general'),
                    'country': data.get('country', 'both'),
                    'sources': data.get('sources', []),
                }
        
        # 检查板块关键词
        for sector, keywords in self.sector_keywords.items():
            if keyword in keywords:
                return {
                    'keyword': keyword,
                    'category': f'sector_{sector}',
                    'name': f'{sector}板块',
                    'importance': 65,
                    'category_type': 'sector',
                    'country': 'cn',
                    'sources': ['all'],
                }
        
        return None
    
    def get_statistics(self) -> Dict[str, Any]:
        """获取关键词库统计信息"""
        total_core_keywords = sum(
            len(data['keywords']) for data in self.core_keywords.values()
        )
        total_sector_keywords = sum(
            len(keywords) for keywords in self.sector_keywords.values()
        )
        
        high_importance = sum(
            1 for data in self.core_keywords.values()
            if data.get('importance', 0) >= 80
        )
        
        return {
            'total_categories': len(self.core_keywords),
            'total_core_keywords': total_core_keywords,
            'total_sector_keywords': total_sector_keywords,
            'total_keywords': total_core_keywords + total_sector_keywords,
            'high_importance_categories': high_importance,
            'sectors_count': len(self.sector_keywords),
            'synonym_groups': len(self.synonym_mappings),
        }


# 全局实例
_sentiment_keywords = None


def get_sentiment_keywords() -> SentimentKeywords:
    """获取关键词库全局实例"""
    global _sentiment_keywords
    if _sentiment_keywords is None:
        _sentiment_keywords = SentimentKeywords()
    return _sentiment_keywords