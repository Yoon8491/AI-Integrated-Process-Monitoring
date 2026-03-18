"""공정 대시보드용 DB 헬퍼 (Next.js lib/dashboard-db.ts 포팅)."""
import re
from datetime import datetime
from zoneinfo import ZoneInfo

from config import PROCESS_DB, BACKEND_DATE_TZ
from db import get_process_connection


def escape_sql_id(name: str) -> str:
    safe = str(name).replace("`", "``")
    return f"`{safe}`"


def is_safe_column_name(name: str) -> bool:
    return bool(name and re.match(r"^[a-zA-Z0-9_\s]+$", name))


def get_tables(conn) -> list:
    with conn.cursor() as cur:
        cur.execute("SHOW TABLES")
        rows = cur.fetchall()
    if not rows:
        return []
    key = list(rows[0].keys())[0]
    return [r[key] for r in rows if r.get(key)]


def get_columns(conn, table: str) -> list[dict]:
    db = PROCESS_DB["database"]
    with conn.cursor() as cur:
        cur.execute(
            """SELECT COLUMN_NAME as name, DATA_TYPE as type
               FROM information_schema.COLUMNS
               WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s
               ORDER BY ORDINAL_POSITION""",
            (db, table),
        )
        return cur.fetchall() or []


def _pick_column(columns: list[dict], candidates: list[str]) -> str | None:
    names = [c["name"].lower() for c in columns]
    for cand in candidates:
        if cand.lower() in names:
            for c in columns:
                if c["name"].lower() == cand.lower():
                    return c["name"]
        for c in columns:
            if cand.lower() in c["name"].lower() or c["name"].lower() in cand.lower():
                return c["name"]
    return None


def _is_date_type(t: str) -> bool:
    t = (t or "").lower()
    return "date" in t or "time" in t or t == "timestamp"


def _is_numeric_type(t: str) -> bool:
    t = (t or "").lower()
    return "int" in t or "decimal" in t or "float" in t or "double" in t


def get_process_data_table(conn) -> str:
    import os
    fixed = os.getenv("PROCESS_TABLE_NAME", "").strip()
    return fixed or "preprocessing"


def _find_date_column(columns: list[dict]) -> str | None:
    date_names = ["timestamp", "date", "created_at", "recorded_at", "dt", "time", "날짜"]
    found = _pick_column(columns, date_names)
    if found:
        return found
    for c in columns:
        if _is_date_type(c["type"]):
            return c["name"]
    return None


def get_process_column_map(conn, table_name: str) -> dict:
    columns = get_columns(conn, table_name)
    date_col = _find_date_column(columns)
    quantity_col = _pick_column(columns, ["quantity", "amount", "count", "qty", "output", "생산", "수량"])
    pass_rate_col = _pick_column(columns, ["pass_rate", "pass", "quality", "ok_rate", "양품률", "품질"])
    defect_col = _pick_column(columns, ["quality_defect", "defect", "defect_rate", "fail", "ng", "불량"])
    consumption_col = _pick_column(columns, ["consumption", "usage", "kwh", "energy", "power", "에너지", "소비"])
    efficiency_col = _pick_column(columns, ["efficiency", "uptime", "oee", "rate", "효율", "가동률"])
    line_col = _pick_column(columns, ["line", "line_id", "line_name", "라인", "공정"])
    lot_col = _pick_column(columns, ["lot_id", "lot", "batch", "lot_no", "batch_id", "LOT", "id"])
    result_col = _pick_column(
        columns,
        [
            "quality_defect", "y_defect", "result", "pass_fail", "judge", "judgment",
            "판정", "합불", "ok_ng", "pass_fail_result", "quality_result", "judgement",
        ],
    )
    numeric_cols = [c["name"] for c in columns if _is_numeric_type(c["type"])]
    quantity_fallback = quantity_col or next((n for n in numeric_cols if "pass" not in n.lower() and "rate" not in n.lower() and "quality" not in n.lower()), None) or (numeric_cols[0] if numeric_cols else None)
    return {
        "table": table_name,
        "dateCol": date_col,
        "quantityCol": quantity_fallback,
        "passRateCol": pass_rate_col,
        "defectCol": defect_col,
        "consumptionCol": consumption_col,
        "efficiencyCol": efficiency_col,
        "lineCol": line_col,
        "lotCol": lot_col,
        "resultCol": result_col,
        "numericCols": numeric_cols,
    }


def get_today_date_string() -> str:
    try:
        tz = ZoneInfo(BACKEND_DATE_TZ)
        now = datetime.now(tz)
        return now.strftime("%Y-%m-%d")
    except Exception:
        return datetime.utcnow().strftime("%Y-%m-%d")


def get_dashboard_date_strings() -> dict:
    today_str = get_today_date_string()
    y, m, d = [int(x) for x in today_str.split("-")]
    from calendar import monthrange
    from datetime import date, timedelta
    last_day = monthrange(y, m)[1]
    first_of_month = f"{y}-{m:02d}-01"
    last_of_month_str = f"{y}-{m:02d}-{last_day:02d}"
    today = date(y, m, d)
    # 월~일: Python weekday() = 월0 .. 일6
    mon = today - timedelta(days=today.weekday())
    sun = mon + timedelta(days=6)
    week_start_str = mon.strftime("%Y-%m-%d")
    week_end_str = sun.strftime("%Y-%m-%d")
    return {
        "todayStr": today_str,
        "weekStartStr": week_start_str,
        "weekEndStr": week_end_str,
        "firstOfMonth": first_of_month,
        "lastOfMonthStr": last_of_month_str,
    }
