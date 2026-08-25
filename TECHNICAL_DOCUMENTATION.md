# 🌐 舆情联动监控系统 - 技术文档

## 📋 目录
1. [系统架构](#系统架构)
2. [技术栈](#技术栈)
3. [数据库设计](#数据库设计)
4. [API接口文档](#API接口文档)
5. [部署指南](#部署指南)
6. [开发指南](#开发指南)

---

## 系统架构

### 整体架构
```
┌─────────────────────────────────────────────────────────┐
│                    前端 (React/JavaScript)                │
├─────────────────────────────────────────────────────────┤
│  舆情面板 │ 事件日历 │ 关键词管理 │ 投资建议              │
└─────────────────────────────────────────────────────────┘
                         ↓ WebSocket ↑
┌─────────────────────────────────────────────────────────┐
│                 后端 (FastAPI + Python)                   │
├─────────────────────────────────────────────────────────┤
│ 舆情监控 │ 板块映射 │ 历史预测 │ 个性化引擎              │
└─────────────────────────────────────────────────────────┘
                         ↓ HTTP ↑
┌─────────────────────────────────────────────────────────┐
│                    数据层 (SQLite)                       │
├─────────────────────────────────────────────────────────┤
│ 舆情数据 │ 事件日历 │ 历史影响 │ 用户偏好              │
└─────────────────────────────────────────────────────────┘
```

### 核心模块

#### 1. 舆情监控模块 (sentiment_monitor.py)
- **功能**: 实时监控中美重要舆情
- **数据源**: 东方财富、新浪财经、美联储官网
- **处理流程**: 抓取 → 过滤 → 存储 → 关联分析 → 推送

#### 2. 新闻过滤模块 (news_filter.py)
- **功能**: 基于关键词和重要性智能过滤
- **算法**: TF-IDF + 规则引擎 + 重要性评分
- **输出**: 高重要性舆情列表(60分以上)

#### 3. 板块映射模块 (sector_mapper.py)
- **功能**: 舆情关键词到板块的映射
- **数据**: 200+关键词，10大板块映射规则
- **输出**: 相关板块列表及影响方向

#### 4. 历史影响模块 (impact_history.py)
- **功能**: 存储和分析历史事件影响
- **数据**: 2019年至今重要事件样本
- **输出**: 历史统计和概率预测

#### 5. 个性化引擎 (user_preference.py)
- **功能**: 学习用户偏好和行为模式
- **算法**: 行为追踪 + 协同过滤 + 个性化排序
- **输出**: 个性化舆情推荐

---

## 技术栈

### 后端技术
- **Web框架**: FastAPI 0.104+
- **数据库**: SQLite 3
- **异步处理**: asyncio
- **HTTP客户端**: httpx
- **日志系统**: loguru
- **数据验证**: pydantic

### 前端技术
- **框架**: React (集成在现有系统)
- **WebSocket**: 原生WebSocket API
- **状态管理**: React Hooks
- **样式**: CSS3

### 数据源
- **东方财富**: 国内财经新闻
- **新浪财经**: 补充新闻源
- **美联储官网**: 美国货币政策
- **Investing.com**: 经济日历数据
- **Trading Economics**: 备用数据源

---

## 数据库设计

### 舆情数据库 (sentiment_news.db)

#### 表结构: sentiment_news
```sql
CREATE TABLE sentiment_news (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT,
    url TEXT,
    source TEXT NOT NULL,
    country TEXT NOT NULL,
    event_type TEXT,
    importance_score REAL DEFAULT 60.0,
    sentiment_tag TEXT DEFAULT 'neutral',
    published_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_importance ON sentiment_news(importance_score);
CREATE INDEX idx_published ON sentiment_news(published_at);
CREATE INDEX idx_source ON sentiment_news(source, country);
```

### 事件日历数据库 (event_calendar.db)

#### 表结构: event_calendar
```sql
CREATE TABLE event_calendar (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT,
    country TEXT NOT NULL,
    event_type TEXT NOT NULL,
    importance INTEGER DEFAULT 3,
    timezone TEXT,
    actual_value TEXT,
    forecast_value TEXT,
    previous_value TEXT,
    impact_score REAL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(name, date, time)
);

CREATE INDEX idx_date ON event_calendar(date);
CREATE INDEX idx_importance ON event_calendar(importance);
CREATE INDEX idx_type ON event_calendar(event_type);
```

### 历史影响数据库 (sentiment_impact_history.db)

#### 表结构: impact_history
```sql
CREATE TABLE impact_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_name TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_date TEXT NOT NULL,
    country TEXT NOT NULL,
    sector_name TEXT NOT NULL,
    impact_direction TEXT NOT NULL,
    impact_magnitude REAL NOT NULL,
    market_context TEXT,
    sample_quality INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(event_name, event_date, sector_name)
);

CREATE INDEX idx_event_name ON impact_history(event_name);
CREATE INDEX idx_event_type ON impact_history(event_type);
CREATE INDEX idx_sector ON impact_history(sector_name);
CREATE INDEX idx_date ON impact_history(event_date);
```

### 用户数据存储

#### 关键词存储 (sentiment_user_keywords.json)
```json
{
  "user_keywords": [
    {
      "id": "uuid",
      "keyword": "降息",
      "category": "货币政策",
      "importance": 90,
      "notes": "关注央行降息相关新闻",
      "created_at": "2024-01-01"
    }
  ],
  "stock_keywords": {},
  "blacklist": ["广告", "促销"],
  "created_at": "2024-01-01",
  "updated_at": "2024-01-01"
}
```

#### 用户偏好存储 (sentiment_user_preferences.json)
```json
{
  "sector_preferences": {
    "科技": 0.8,
    "医药": 0.6
  },
  "sentiment_type_preferences": {
    "positive": 0.7,
    "negative": 0.3
  },
  "importance_threshold": 70,
  "risk_preference": "moderate",
  "behavior_stats": {
    "total_clicks": 150,
    "sector_clicks": {"科技": 50},
    "sentiment_type_clicks": {"positive": 100}
  }
}
```

---

## API接口文档

### 舆情相关接口

#### 获取舆情列表
```http
GET /api/sentiment/news?limit=50&min_score=70&country=cn
```

**响应示例**:
```json
{
  "total": 150,
  "filtered": 80,
  "news": [
    {
      "id": "news_001",
      "title": "美联储宣布降息25个基点",
      "content": "美联储主席鲍威尔...",
      "source": "fed",
      "country": "us",
      "importance_score": 95,
      "sentiment_tag": "positive",
      "published_at": "2024-01-15 15:30:00",
      "related_sectors": [
        {
          "sector_name": "黄金",
          "impact": "positive",
          "relevance": 0.9,
          "reasoning": "降息利好黄金"
        }
      ]
    }
  ]
}
```

#### 获取投资建议
```http
POST /api/sentiment/investment-advice
Content-Type: application/json

{
  "news_id": "news_001",
  "include_stocks": true
}
```

**响应示例**:
```json
{
  "sentiment": {...},
  "related_sectors": [...],
  "related_stocks": [
    {
      "stock_code": "600547",
      "stock_name": "山东黄金",
      "match_type": "sector_relation"
    }
  ],
  "investment_advice": {
    "has_advice": true,
    "overall_impact": {
      "direction": "positive",
      "level": "major",
      "confidence": "high"
    },
    "stock_tips": [
      {
        "stock_name": "山东黄金",
        "stock_code": "600547",
        "tip_text": "🔥 山东黄金 重大利好！...\n\n💡 操作建议：考虑逢低布局",
        "action_suggestion": "consider_buying"
      }
    ]
  }
}
```

### 事件日历接口

#### 获取即将到来的事件
```http
GET /api/calendar/upcoming?days=30
```

**响应示例**:
```json
{
  "2024-01-18": [
    {
      "id": "event_001",
      "name": "美联储FOMC会议",
      "date": "2024-01-18",
      "time": "03:00",
      "country": "us",
      "event_type": "monetary_policy",
      "importance": 5,
      "timezone": "EST",
      "days_until": 3
    }
  ]
}
```

#### 分析事件影响
```http
POST /api/calendar/analyze-impact
Content-Type: application/json

{
  "event_name": "美联储FOMC会议",
  "event_type": "monetary_policy",
  "sectors": ["黄金", "银行"],
  "market_context": {
    "trend": "uptrend",
    "sentiment": "positive"
  }
}
```

### 历史影响接口

#### 预测事件影响
```http
POST /api/impact/predict
Content-Type: application/json

{
  "event_name": "美联储FOMC会议",
  "event_type": "monetary_policy",
  "sector_name": "黄金",
  "market_context": {
    "trend": "uptrend",
    "valuation": "fair",
    "sentiment": "positive"
  }
}
```

**响应示例**:
```json
{
  "sector_name": "黄金",
  "prediction_available": true,
  "historical_sample_count": 15,
  "probabilities": {
    "positive": 75.5,
    "negative": 15.2,
    "neutral": 9.3
  },
  "expected_return": 1.8,
  "confidence": "high",
  "prediction_reasoning": "基于15个历史样本；历史上75.5%概率为正面影响；预测置信度: 高"
}
```

### 个性化接口

#### 更新持仓数据
```http
POST /api/user/positions/update
Content-Type: application/json

[
  {
    "code": "600547",
    "name": "山东黄金",
    "quantity": 1000,
    "cost": 35.50,
    "current_price": 38.20,
    "market_value": 38200,
    "profit_loss_pct": 7.6
  }
]
```

#### 记录用户行为
```http
POST /api/user/click/record
Content-Type: application/json

{
  "sentiment_id": "news_001",
  "click_type": "view"
}
```

---

## 部署指南

### 环境要求

#### 系统要求
- **操作系统**: Linux/MacOS/Windows
- **Python版本**: Python 3.10+
- **内存**: 最小2GB，推荐4GB+
- **存储**: 最小1GB可用空间

#### Python依赖
```bash
pip install fastapi uvicorn httpx loguru pydantic
```

### 本地部署

#### 1. 克隆代码
```bash
git clone https://github.com/your-repo/dsh-stock-plugin.git
cd dsh-stock-plugin
```

#### 2. 安装依赖
```bash
pip install -r requirements.txt
```

#### 3. 初始化数据库
```bash
# 数据库会在首次运行时自动创建
python -c "from backend.sentiment_db import get_sentiment_db; get_sentiment_db()"
```

#### 4. 启动服务
```bash
# 启动FastAPI服务器
cd plugin/backend
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

#### 5. 访问系统
```
前端: http://localhost:3000 (根据现有系统配置)
后端API: http://localhost:8000
API文档: http://localhost:8000/docs
```

### Docker部署

#### Dockerfile
```dockerfile
FROM python:3.10-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

#### docker-compose.yml
```yaml
version: '3.8'

services:
  backend:
    build: .
    ports:
      - "8000:8000"
    volumes:
      - ./data:/root/.dsh/stock-data
    environment:
      - PYTHONUNBUFFERED=1
    restart: unless-stopped
```

#### 启动服务
```bash
docker-compose up -d
```

---

## 开发指南

### 项目结构
```
dsh-stock-plugin/
├── plugin/
│   ├── backend/                    # 后端代码
│   │   ├── main.py                # FastAPI主入口
│   │   ├── sentiment_monitor.py   # 舆情监控
│   │   ├── news_filter.py         # 新闻过滤
│   │   ├── sector_mapper.py       # 板块映射
│   │   ├── impact_history.py      # 历史影响
│   │   ├── user_preference.py      # 用户偏好
│   │   └── ...其他模块
│   └── lib/
│       └── client.js              # 前端React组件
└── docs/                          # 文档
```

### 开发规范

#### 代码规范
- **Python**: 遵循PEP 8规范
- **JavaScript**: 使用ES6+语法
- **注释**: 重要函数必须添加文档字符串
- **错误处理**: 所有异常必须被捕获和记录

#### 测试规范
- **单元测试**: 每个模块都应有单元测试
- **集成测试**: 端到端功能测试
- **性能测试**: 压力测试和性能基准

#### 文档规范
- **API文档**: 使用OpenAPI规范
- **代码注释**: 关键算法添加详细注释
- **变更日志**: 维护详细的变更记录

### 扩展开发

#### 添加新的数据源
1. 在`sentiment_monitor.py`中创建新的NewsDataSource类
2. 实现`fetch_news()`方法
3. 添加到数据源列表中

#### 添加新的板块映射
1. 在`sector_mapper.py`中添加关键词映射规则
2. 更新板块成分股数据
3. 测试映射准确性

#### 添加新的预测算法
1. 在`impact_predictor.py`中实现新的预测逻辑
2. 添加历史样本数据
3. 验证预测准确性

### 性能优化

#### 数据库优化
```sql
-- 添加适当的索引
CREATE INDEX idx_composite ON sentiment_news(source, importance_score);
CREATE INDEX idx_date_range ON event_calendar(date, importance);

-- 定期清理过期数据
DELETE FROM sentiment_news WHERE published_at < date('now', '-90 days');
```

#### 缓存策略
```python
# Redis缓存热门数据
import redis

cache = redis.Redis(host='localhost', port=6379)

def get_news_with_cache():
    cached = cache.get('latest_news')
    if cached:
        return json.loads(cached)
    
    news = fetch_news()
    cache.setex('latest_news', 300, json.dumps(news))  # 5分钟缓存
    return news
```

#### 异步处理
```python
# 使用异步处理提高并发能力
async def process_multiple_sources():
    tasks = [source.fetch_news() for source in data_sources]
    results = await asyncio.gather(*tasks)
    return results
```

---

## 监控和日志

### 日志配置
```python
# loguru配置
logger.add(
    "logs/sentiment_{time}.log",
    rotation="1 day",
    retention="30 days",
    level="INFO",
    format="{time} | {level} | {message}"
)
```

### 性能监控
```python
import time

def monitor_performance(func):
    def wrapper(*args, **kwargs):
        start = time.time()
        result = func(*args, **kwargs)
        duration = time.time() - start
        
        logger.info(f"{func.__name__} 执行时间: {duration:.2f}s")
        
        if duration > 1.0:  # 超过1秒记录警告
            logger.warning(f"{func.__name__} 执行缓慢: {duration:.2f}s")
        
        return result
    return wrapper
```

### 错误处理
```python
# 全局异常处理
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"未处理的异常: {exc}")
    return JSONResponse(
        status_code=500,
        content={"detail": "服务器内部错误"}
    )
```

---

## 安全考虑

### 数据安全
- **输入验证**: 所有用户输入必须验证
- **SQL注入**: 使用参数化查询
- **XSS防护**: 前端输出转义

### 访问控制
```python
# API访问频率限制
from fastapi_limiter import FastAPILimiter

limiter = FastAPILimiter(redis_host="localhost")

@app.get("/api/sentiment/news")
@limiter.limit("10/minute")  # 每分钟10次
async def get_news():
    pass
```

### 数据加密
```python
# 敏感数据加密
from cryptography.fernet import Fernet

key = Fernet.generate_key()
cipher = Fernet(key)

def encrypt_data(data: str) -> str:
    return cipher.encrypt(data.encode()).decode()
```

---

**文档版本**: v1.0.0  
**最后更新**: 2024-01-15  
**维护者**: DSH Stock Plugin Team