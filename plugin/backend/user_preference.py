"""
用户偏好学习模块

提供：
- 用户行为追踪（舆情点击、操作偏好、风险偏好）
- 个性化推送策略
- 用户反馈机制
- 学习算法优化
"""

import json
from typing import List, Dict, Any, Optional, Set
from datetime import datetime, timedelta
from loguru import logger
from pathlib import Path


class UserPreference:
    """用户偏好学习引擎"""
    
    def __init__(self):
        """初始化用户偏好学习器"""
        # 用户偏好数据文件
        self.data_file = Path.home() / ".dsh" / "stock-data" / "sentiment_user_preferences.json"
        self.data_file.parent.mkdir(parents=True, exist_ok=True)
        
        # 加载用户偏好数据
        self.preferences = self._load_preferences()
    
    def _load_preferences(self) -> Dict[str, Any]:
        """加载用户偏好数据"""
        if self.data_file.exists():
            try:
                with open(self.data_file, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except Exception as e:
                logger.warning(f"加载用户偏好数据失败: {e}")
        
        # 返回默认偏好
        return self._get_default_preferences()
    
    def _get_default_preferences(self) -> Dict[str, Any]:
        """获取默认偏好设置"""
        return {
            'user_id': 'default',
            'created_at': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            'updated_at': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            
            # 板块偏好（关注度权重）
            'sector_preferences': {
                '科技': 0.5,
                '医药': 0.5,
                '消费': 0.5,
                '新能源': 0.5,
                '金融': 0.5,
                '地产': 0.5,
                '军工': 0.5,
                '半导体': 0.5,
                '黄金': 0.5,
                '原材料': 0.5
            },
            
            # 舆情类型偏好
            'sentiment_type_preferences': {
                'positive': 0.6,  # 倾向于看正面舆情
                'negative': 0.4,  # 相对少看负面舆情
                'neutral': 0.5
            },
            
            # 重要性阈值偏好
            'importance_threshold': 70,  # 默认只显示70分以上
            
            # 风险偏好
            'risk_preference': 'moderate',  # conservative/moderate/aggressive
            
            # 推送频率偏好
            'push_frequency': 'normal',  # low/normal/high
            
            # 行为统计
            'behavior_stats': {
                'total_clicks': 0,
                'sector_clicks': {},
                'sentiment_type_clicks': {'positive': 0, 'negative': 0, 'neutral': 0},
                'importance_distribution': {},
                'active_hours': [9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20]  # 默认交易时间
            },
            
            # 历史记录
            'click_history': [],
            'feedback_history': []
        }
    
    def _save_preferences(self):
        """保存用户偏好数据"""
        try:
            self.preferences['updated_at'] = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            with open(self.data_file, 'w', encoding='utf-8') as f:
                json.dump(self.preferences, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.error(f"保存用户偏好数据失败: {e}")
    
    def record_click(self, sentiment_news: Dict[str, Any], click_type: str = 'view'):
        """记录用户点击行为"""
        
        # 获取当前小时
        current_hour = datetime.now().hour
        
        # 更新统计信息
        self.preferences['behavior_stats']['total_clicks'] += 1
        
        # 记录板块点击
        related_sectors = sentiment_news.get('related_sectors', [])
        for sector in related_sectors:
            sector_name = sector.get('sector_name', '')
            if sector_name:
                self.preferences['behavior_stats']['sector_clicks'][sector_name] = \
                    self.preferences['behavior_stats']['sector_clicks'].get(sector_name, 0) + 1
        
        # 记录舆情类型点击
        sentiment_tag = sentiment_news.get('sentiment_tag', 'neutral')
        self.preferences['behavior_stats']['sentiment_type_clicks'][sentiment_tag] = \
            self.preferences['behavior_stats']['sentiment_type_clicks'].get(sentiment_tag, 0) + 1
        
        # 记录重要性分布
        importance_score = sentiment_news.get('importance_score', 60)
        importance_range = self._get_importance_range(importance_score)
        self.preferences['behavior_stats']['importance_distribution'][importance_range] = \
            self.preferences['behavior_stats']['importance_distribution'].get(importance_range, 0) + 1
        
        # 记录活跃时间
        if current_hour not in self.preferences['behavior_stats']['active_hours']:
            self.preferences['behavior_stats']['active_hours'].append(current_hour)
        
        # 添加到历史记录（限制最近1000条）
        click_record = {
            'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            'sentiment_id': sentiment_news.get('id'),
            'sentiment_title': sentiment_news.get('title', ''),
            'click_type': click_type,
            'sectors': [s.get('sector_name') for s in related_sectors],
            'sentiment_tag': sentiment_tag,
            'importance_score': importance_score
        }
        
        self.preferences['click_history'].append(click_record)
        if len(self.preferences['click_history']) > 1000:
            self.preferences['click_history'] = self.preferences['click_history'][-1000:]
        
        # 定期更新偏好（每10次点击）
        if self.preferences['behavior_stats']['total_clicks'] % 10 == 0:
            self._update_preferences_from_behavior()
        
        self._save_preferences()
    
    def _get_importance_range(self, score: int) -> str:
        """获取重要性范围标签"""
        if score >= 90:
            return '90+'
        elif score >= 80:
            return '80-89'
        elif score >= 70:
            return '70-79'
        elif score >= 60:
            return '60-69'
        else:
            return 'below_60'
    
    def _update_preferences_from_behavior(self):
        """从行为统计更新偏好"""
        
        stats = self.preferences['behavior_stats']
        
        if stats['total_clicks'] == 0:
            return
        
        # 更新板块偏好
        total_sector_clicks = sum(stats['sector_clicks'].values())
        if total_sector_clicks > 0:
            for sector, clicks in stats['sector_clicks'].items():
                # 平滑更新：新旧偏好各占50%
                current_pref = self.preferences['sector_preferences'].get(sector, 0.5)
                new_pref = clicks / total_sector_clicks
                updated_pref = current_pref * 0.5 + new_pref * 0.5
                self.preferences['sector_preferences'][sector] = round(updated_pref, 2)
        
        # 更新舆情类型偏好
        total_sentiment_clicks = sum(stats['sentiment_type_clicks'].values())
        if total_sentiment_clicks > 0:
            for sentiment_type, clicks in stats['sentiment_type_clicks'].items():
                current_pref = self.preferences['sentiment_type_preferences'].get(sentiment_type, 0.5)
                new_pref = clicks / total_sentiment_clicks
                updated_pref = current_pref * 0.7 + new_pref * 0.3  # 更保守的更新
                self.preferences['sentiment_type_preferences'][sentiment_type] = round(updated_pref, 2)
        
        # 更新重要性阈值（根据用户平均浏览的重要性）
        if stats['importance_distribution']:
            # 计算加权平均重要性
            weighted_sum = 0
            total_count = 0
            
            importance_weights = {
                '90+': 95,
                '80-89': 85,
                '70-79': 75,
                '60-69': 65,
                'below_60': 55
            }
            
            for range_name, count in stats['importance_distribution'].items():
                weight = importance_weights.get(range_name, 60)
                weighted_sum += weight * count
                total_count += count
            
            if total_count > 0:
                avg_importance = weighted_sum / total_count
                # 逐步调整阈值，不要太激进
                current_threshold = self.preferences['importance_threshold']
                new_threshold = current_threshold * 0.8 + avg_importance * 0.2
                self.preferences['importance_threshold'] = round(new_threshold)
        
        logger.info("用户偏好已根据行为统计更新")
    
    def calculate_personalized_score(self, sentiment_news: Dict[str, Any]) -> float:
        """计算个性化评分"""
        
        base_score = sentiment_news.get('importance_score', 60)
        
        # 板块偏好加成
        related_sectors = sentiment_news.get('related_sectors', [])
        sector_bonus = 0
        for sector in related_sectors:
            sector_name = sector.get('sector_name', '')
            sector_preference = self.preferences['sector_preferences'].get(sector_name, 0.5)
            # 将0-1的偏好转换为-5到+5的加分
            sector_bonus += (sector_preference - 0.5) * 10
        
        # 舆情类型偏好加成
        sentiment_tag = sentiment_news.get('sentiment_tag', 'neutral')
        sentiment_preference = self.preferences['sentiment_type_preferences'].get(sentiment_tag, 0.5)
        sentiment_bonus = (sentiment_preference - 0.5) * 8
        
        # 综合加分
        total_bonus = sector_bonus + sentiment_bonus
        personalized_score = base_score + total_bonus
        
        return round(max(personalized_score, 0), 1)
    
    def should_push_notification(self, sentiment_news: Dict[str, Any]) -> bool:
        """判断是否应该推送通知"""
        
        # 基础重要性检查
        importance_score = sentiment_news.get('importance_score', 60)
        threshold = self.preferences['importance_threshold']
        
        if importance_score < threshold:
            return False
        
        # 推送频率控制
        push_frequency = self.preferences['push_frequency']
        
        # 检查最近的推送记录
        recent_pushes = [
            click for click in self.preferences['click_history'][-20:]  # 最近20次
            if click.get('click_type') == 'notification'
        ]
        
        # 计算时间间隔
        if recent_pushes:
            last_push_time = datetime.strptime(recent_pushes[-1]['timestamp'], '%Y-%m-%d %H:%M:%S')
            time_since_last_push = (datetime.now() - last_push_time).total_seconds() / 60  # 分钟
            
            if push_frequency == 'low' and time_since_last_push < 60:
                return False
            elif push_frequency == 'normal' and time_since_last_push < 30:
                return False
            elif push_frequency == 'high' and time_since_last_push < 15:
                return False
        
        # 个性化相关性检查
        related_sectors = sentiment_news.get('related_sectors', [])
        sector_relevance = False
        for sector in related_sectors:
            sector_name = sector.get('sector_name', '')
            if self.preferences['sector_preferences'].get(sector_name, 0.5) > 0.7:
                sector_relevance = True
                break
        
        # 高优先级舆情或相关板块舆情才推送
        return importance_score >= 90 or sector_relevance
    
    def get_user_statistics(self) -> Dict[str, Any]:
        """获取用户统计信息"""
        
        stats = self.preferences['behavior_stats']
        
        # 计算最喜欢的板块
        favorite_sectors = sorted(
            self.preferences['sector_preferences'].items(),
            key=lambda x: x[1],
            reverse=True
        )[:3]
        
        # 计算活跃时间段
        active_hours = self.preferences['behavior_stats']['active_hours']
        
        return {
            'total_interactions': stats['total_clicks'],
            'favorite_sectors': [{'name': name, 'preference': pref} for name, pref in favorite_sectors],
            'importance_threshold': self.preferences['importance_threshold'],
            'risk_preference': self.preferences['risk_preference'],
            'push_frequency': self.preferences['push_frequency'],
            'active_hours': active_hours,
            'recent_activity_count': len([c for c in self.preferences['click_history'] 
                                        if datetime.strptime(c['timestamp'], '%Y-%m-%d %H:%M:%S') > 
                                        datetime.now() - timedelta(days=7)])
        }
    
    def reset_preferences(self):
        """重置用户偏好为默认值"""
        self.preferences = self._get_default_preferences()
        self._save_preferences()
        logger.info("用户偏好已重置为默认值")


def get_user_preference() -> UserPreference:
    """获取用户偏好学习器实例"""
    return UserPreference()
