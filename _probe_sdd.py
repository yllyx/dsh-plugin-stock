# -*- coding: utf-8 -*-
"""个股详情页缺口接口批量实测"""
import sys, json, io, types
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
lg = types.ModuleType("loguru")
class _L:
    def __getattr__(self, n): return lambda *a, **k: None
lg.logger = _L()
sys.modules["loguru"] = lg
sys.path.insert(0, "plugin/backend")
from kpl import KplClient
c = KplClient()
HQ = "https://apphwhq.kaipanla.com/w1/api/index.php"
HIS = "https://apphis.kaipanla.com/w1/api/index.php"
ART = "https://apparticle.longhuvip.com/w1/api/index.php"
CODE = "688185"
def show(label, d, n=260):
    s = json.dumps(d, ensure_ascii=False)
    print("== %s: len=%s err=%s" % (label, len(s), (d or {}).get("errcode")))
    print("   ", s[:n])
show("涨停原因历史 KLineZhangTingReason", c.call(HIS, "HisLimitResumption", "KLineZhangTingReason", {"StockID": CODE, "Date": "2026-09-30"}, False))
show("机构持仓 StockInstitutionalPositions", c.call(HIS, "HisHomeDingPan", "StockInstitutionalPositions", {"StockID": CODE}, False))
show("机构持仓日期 InstitutionalShowDate", c.call(HIS, "HisHomeDingPan", "InstitutionalShowDate", {"StockID": CODE}, False))
show("公司新闻 CorporateNewsStockList", c.call(HIS, "CompanyNotice", "CorporateNewsStockList", {"StockID": CODE, "Index": "0", "st": "10"}, False))
show("研报 CompanyNewsReportList", c.call(HIS, "CompanyNotice", "CompanyNewsReportList", {"StockID": CODE, "Index": "0", "st": "10", "Type": "0"}, False))
show("研报分类 ResearchFieldList", c.call(HIS, "CompanyNotice", "ResearchFieldList", {"StockID": CODE, "Type": "0", "Index": "0", "st": "10"}, False))
show("大事提醒 BigReminderW43", c.call(ART, "StockF10Basic", "BigReminderW43", {"StockID": CODE, "Index": "0", "st": "10"}, False))
show("公司资料 GetCompanyInfo", c.call(ART, "StockF10Basic", "GetCompanyInfo", {"StockID": CODE}, False))
show("财务 GetFinanceInfo", c.call(ART, "StockF10Basic", "GetFinanceInfo", {"StockID": CODE, "State": "1", "Type": "1", "DL": ""}, False))
show("主力监控 StockMainMonitor", c.call(HQ, "StockYiDongKanPan", "StockMainMonitor", {"StockID": CODE, "Money": "300000", "Sort": "1", "Type": "1", "Order": "0", "Index": "0", "st": "30"}, False))
show("分时历史 StockL2History", c.call(HIS, "StockL2Data", "StockL2History", {"StockID": CODE, "Day": "2026-09-30"}, False))
show("基金持仓 StockHoldingFund", c.call(HIS, "HisHomeDingPan", "StockHoldingFund", {"StockID": CODE, "Season": "", "Type": "0", "Index": "0", "st": "10"}, False))
