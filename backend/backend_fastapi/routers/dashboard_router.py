"""대시보드 API (summary, calendar-month, lot-status 등)."""
from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from auth_jwt import verify_token
from db import get_process_connection
from dashboard_db import (
    get_process_data_table,
    get_process_column_map,
    get_today_date_string,
    get_dashboard_date_strings,
    escape_sql_id,
    is_safe_column_name,
    get_columns,
)

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])
security = HTTPBearer(auto_error=False)


async def require_auth(credentials: HTTPAuthorizationCredentials = Depends(security)):
    if not credentials or credentials.scheme != "Bearer" or not credentials.credentials:
        raise HTTPException(status_code=401, detail="Unauthorized")
    user = verify_token(credentials.credentials)
    if not user:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return user


def ensure_lot_defect_reports_table():
    """불량 LOT 알람/레포트용 테이블. PROCESS_DB(project)에 없으면 생성."""
    with get_process_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS lot_defect_reports (
                    id INT NOT NULL DEFAULT 0,
                    lot_id VARCHAR(100) NOT NULL PRIMARY KEY,
                    report_content TEXT NOT NULL,
                    lot_data_json JSON,
                    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_id (id),
                    INDEX idx_timestamp (timestamp)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            """)
            conn.commit()


@router.get("/summary")
async def summary(user=Depends(require_auth)):
    try:
        with get_process_connection() as conn:
            table = get_process_data_table(conn)
            m = get_process_column_map(conn, table)
            today_str = get_today_date_string()
            date_col = m["dateCol"]
            date_condition = f"WHERE DATE({escape_sql_id(date_col)}) = %s" if date_col else ""
            production_today = None
            equipment_rate = None
            quality_rate = None
            energy_today = None
            with conn.cursor() as cur:
                if m["quantityCol"] and date_col:
                    cur.execute(
                        f"SELECT COALESCE(SUM({escape_sql_id(m['quantityCol'])}), 0) as total FROM {escape_sql_id(table)} {date_condition}",
                        (today_str,),
                    )
                    row = cur.fetchone()
                    production_today = float(row["total"] or 0) if row else None
                if m["efficiencyCol"] and date_col:
                    cur.execute(
                        f"SELECT AVG({escape_sql_id(m['efficiencyCol'])}) as avg_rate FROM {escape_sql_id(table)} {date_condition}",
                        (today_str,),
                    )
                    row = cur.fetchone()
                    if row and row.get("avg_rate") is not None:
                        equipment_rate = float(row["avg_rate"])
                if m["passRateCol"] and date_col:
                    cur.execute(
                        f"SELECT AVG({escape_sql_id(m['passRateCol'])}) as avg_rate FROM {escape_sql_id(table)} {date_condition}",
                        (today_str,),
                    )
                    row = cur.fetchone()
                    if row and row.get("avg_rate") is not None:
                        quality_rate = float(row["avg_rate"])
                if m["consumptionCol"] and date_col:
                    cur.execute(
                        f"SELECT COALESCE(SUM({escape_sql_id(m['consumptionCol'])}), 0) as total FROM {escape_sql_id(table)} {date_condition}",
                        (today_str,),
                    )
                    row = cur.fetchone()
                    energy_today = float(row["total"] or 0) if row else None
            from_db = any(x is not None for x in [production_today, equipment_rate, quality_rate, energy_today])
            return {
                "success": True,
                "data": {
                    "productionToday": production_today,
                    "equipmentRate": equipment_rate,
                    "qualityRate": quality_rate,
                    "energyToday": energy_today,
                },
                "fromDb": from_db,
                "tables": [table],
                "usedTables": [table],
            }
    except Exception as e:
        return {"success": False, "error": str(e), "data": None, "fromDb": False, "tables": [], "usedTables": []}


@router.get("/calendar-month")
async def calendar_month(year: int = None, month: int = None, user=Depends(require_auth)):
    from datetime import datetime
    now = datetime.now()
    year = year or now.year
    month = month or now.month
    try:
        with get_process_connection() as conn:
            table = get_process_data_table(conn)
            m = get_process_column_map(conn, table)
            date_col = m["dateCol"]
            if not date_col:
                return {"success": True, "year": year, "month": month, "days": [], "productionUnit": "개", "productionUnitEn": "ea"}
            month_start = f"{year}-{month:02d}-01"
            from calendar import monthrange
            last_d = monthrange(year, month)[1]
            month_end = f"{year}-{month:02d}-{last_d:02d}"
            qty_col = m["quantityCol"] or "id"
            has_qty = m["quantityCol"] is not None
            quantity_sel = f"COALESCE(SUM({escape_sql_id(qty_col)}), 0)" if has_qty else "COUNT(*)"
            if m["resultCol"]:
                defect_sel = f"AVG(COALESCE(CAST({escape_sql_id(m['resultCol'])} AS DECIMAL(10,4)), 0)) * 100"
            elif m["defectCol"]:
                defect_sel = f"AVG(COALESCE({escape_sql_id(m['defectCol'])}, 0))"
            elif m["passRateCol"]:
                defect_sel = f"100 - AVG(COALESCE({escape_sql_id(m['passRateCol'])}, 100))"
            else:
                defect_sel = "0"
            with conn.cursor() as cur:
                cur.execute(
                    f"""SELECT DAY({escape_sql_id(date_col)}) as d, {quantity_sel} as production, {defect_sel} as defect_rate
                        FROM {escape_sql_id(table)}
                        WHERE {escape_sql_id(date_col)} >= %s AND {escape_sql_id(date_col)} < DATE_ADD(%s, INTERVAL 1 MONTH)
                        GROUP BY DATE({escape_sql_id(date_col)})
                        ORDER BY d""",
                    (month_start, month_start),
                )
                rows = cur.fetchall()
            by_day = {int(r["d"]): {"production": float(r["production"] or 0), "defectRate": float(r["defect_rate"] or 0)} for r in rows}
            days = [{"day": d, "production": by_day.get(d, {}).get("production", 0), "defectRate": by_day.get(d, {}).get("defectRate", 0)} for d in range(1, last_d + 1)]
            unit_ko = "kg" if (m["quantityCol"] or "").lower() in ("lithium_input", "lithium") else "개"
            unit_en = "kg" if unit_ko == "kg" else "ea"
            return {"success": True, "year": year, "month": month, "lastDay": last_d, "days": days, "productionUnit": unit_ko, "productionUnitEn": unit_en}
    except Exception as e:
        return {"success": False, "error": str(e), "year": year, "month": month, "days": [], "productionUnit": "개", "productionUnitEn": "ea"}


@router.get("/lot-status")
async def lot_status(period: str = "", debug: str = "", all_: str = "", noDate: str = "", user=Depends(require_auth)):
    show_all = all_ == "1"
    no_date_filter = noDate == "1"
    try:
        with get_process_connection() as conn:
            table = get_process_data_table(conn)
            m = get_process_column_map(conn, table)
            lot_col = m["lotCol"]
            if not lot_col:
                return {"success": True, "lots": [], "message": "NO_LOT_COLUMN"}
            date_col = m["dateCol"]
            result_col = m["resultCol"] or (m["defectCol"] if m["defectCol"] and "rate" not in (m["defectCol"] or "").lower() else None)
            dates = get_dashboard_date_strings()
            date_condition = ""
            date_params = []
            if date_col and not no_date_filter:
                if period == "day":
                    date_condition = f"WHERE DATE({escape_sql_id(date_col)}) = %s"
                    date_params = [dates["todayStr"]]
                elif period == "week":
                    date_condition = f"WHERE DATE({escape_sql_id(date_col)}) >= %s AND DATE({escape_sql_id(date_col)}) <= %s"
                    date_params = [dates["weekStartStr"], dates["weekEndStr"]]
                elif period == "month":
                    date_condition = f"WHERE DATE({escape_sql_id(date_col)}) >= %s AND DATE({escape_sql_id(date_col)}) <= %s"
                    date_params = [dates["firstOfMonth"], dates["lastOfMonthStr"]]
                else:
                    date_condition = f"WHERE {escape_sql_id(date_col)} >= DATE_SUB(NOW(), INTERVAL 365 DAY)"
            exclude = {lot_col, date_col, result_col} - {None}
            numeric_cols = [c for c in m["numericCols"] if c not in exclude]
            known = ["process_time", "process time", "ProcessTime", "processing_time", "humidity", "tank_pressure", "lithium_input", "additive_ratio"]
            cols = get_columns(conn, table)
            extra = []
            for c in cols:
                name = c["name"]
                if name in exclude or name in numeric_cols:
                    continue
                norm = name.lower().replace(" ", "_")
                for k in known:
                    if norm == k.lower().replace(" ", "_") or k.lower() in norm or norm in k.lower():
                        extra.append(name)
                        break
            param_cols = [c for c in numeric_cols + extra if is_safe_column_name(c)]
            select_parts = [
                f"{escape_sql_id(lot_col)} as lot_id",
                "COUNT(*) as record_count",
            ]
            if date_col:
                select_parts.append(f"MAX({escape_sql_id(date_col)}) as latest_date")
            if result_col and date_col:
                select_parts.append(f"SUBSTRING_INDEX(GROUP_CONCAT(CAST({escape_sql_id(result_col)} AS CHAR) ORDER BY {escape_sql_id(date_col)} DESC), ',', 1) as latest_result")
            elif result_col:
                select_parts.append(f"MAX({escape_sql_id(result_col)}) as latest_result")
            for col in param_cols:
                alias = col.replace(" ", "_")
                alias = "".join(c if c.isalnum() or c == "_" else "_" for c in alias) or "p"
                select_parts.append(f"AVG({escape_sql_id(col)}) as {escape_sql_id('param_' + alias)}")
            having = "" if (debug == "1" or show_all or not result_col) else "HAVING (CONVERT(latest_result, SIGNED) = 1 OR TRIM(CONVERT(latest_result, CHAR)) = '1')"
            limit = "" if period in ("day", "week", "month") else "LIMIT 30"
            sql = f"SELECT {', '.join(select_parts)} FROM {escape_sql_id(table)} {date_condition} GROUP BY {escape_sql_id(lot_col)} {having} ORDER BY CAST(lot_id AS UNSIGNED) ASC, lot_id ASC {limit}".strip()
            with conn.cursor() as cur:
                cur.execute(sql, date_params)
                rows = cur.fetchall()
            lots = []
            for r in rows:
                latest = r.get("latest_result")
                if latest is not None:
                    v = str(latest).strip()
                    pf = "불합격" if v == "1" else ("합격" if v == "0" else v)
                else:
                    pf = None
                params = {}
                for col in param_cols:
                    alias = col.replace(" ", "_")
                    alias = "".join(c if c.isalnum() or c == "_" else "_" for c in alias) or "p"
                    key = f"param_{alias}"
                    val = r.get(key)
                    if val is not None:
                        try:
                            params[col] = float(val)
                        except (TypeError, ValueError):
                            pass
                lots.append({
                    "lotId": str(r.get("lot_id", "")),
                    "passFailResult": pf,
                    "recordCount": int(r.get("record_count", 0)),
                    "latestDate": str(r["latest_date"]) if r.get("latest_date") else None,
                    "lithiumInput": params.get("lithium_input"),
                    "addictiveRatio": params.get("additive_ratio") or params.get("additive_ratio"),
                    "processTime": params.get("process_time"),
                    "humidity": params.get("humidity"),
                    "tankPressure": params.get("tank_pressure"),
                    "params": params,
                })
            return {"success": True, "lots": lots, "totalLots": len(lots)}
    except Exception as e:
        return {"success": False, "error": str(e), "lots": []}


@router.get("/alerts")
async def alerts(user=Depends(require_auth)):
    try:
        with get_process_connection() as conn:
            table = get_process_data_table(conn)
            m = get_process_column_map(conn, table)
            date_col = m["dateCol"]
            if not date_col:
                return {"success": True, "alerts": []}
            numeric = m["numericCols"][:20]
            if not numeric:
                return {"success": True, "alerts": []}
            cols_sql = ", ".join(escape_sql_id(c) for c in numeric)
            with conn.cursor() as cur:
                cur.execute(
                    f"SELECT {cols_sql} FROM {escape_sql_id(table)} ORDER BY {escape_sql_id(date_col)} DESC LIMIT 100",
                )
                rows = cur.fetchall()
            alerts_list = []
            for col in numeric:
                vals = [float(r[col] or 0) for r in rows if r.get(col) is not None]
                if len(vals) < 2:
                    continue
                mean = sum(vals) / len(vals)
                std = (sum((x - mean) ** 2 for x in vals) / len(vals)) ** 0.5 or 1
                last = vals[0]
                dev = (last - mean) / std if std else 0
                if abs(dev) >= 2:
                    alerts_list.append({
                        "column": col,
                        "columnKorean": col,
                        "currentValue": last,
                        "mean": mean,
                        "upperLimit": mean + 2 * std,
                        "lowerLimit": mean - 2 * std,
                        "deviation": dev,
                        "severity": "critical" if abs(dev) >= 3 else "warning",
                    })
            return {"success": True, "alerts": alerts_list[:20]}
    except Exception as e:
        return {"success": False, "alerts": [], "error": str(e)}


@router.get("/analytics")
async def analytics(user=Depends(require_auth)):
    """불량 원인 분석용 상관/중요도 (간단 구현)."""
    try:
        with get_process_connection() as conn:
            table = get_process_data_table(conn)
            m = get_process_column_map(conn, table)
            numeric = [c for c in m["numericCols"] if is_safe_column_name(c)][:30]
            if len(numeric) < 2:
                return {"success": True, "correlation": {"columns": [], "matrix": []}, "importance": [], "confusionMatrix": None, "defectLots": [], "defectTrend": []}
            cols_sql = ", ".join(escape_sql_id(c) for c in numeric)
            with conn.cursor() as cur:
                cur.execute(f"SELECT {cols_sql} FROM {escape_sql_id(table)} LIMIT 1000")
                rows = cur.fetchall()
            n = len(numeric)
            matrix = [[1.0 if i == j else 0.0 for j in range(n)] for i in range(n)]
            importance = [{"name": col, "importance": 0.0} for col in numeric]
            return {
                "success": True,
                "correlation": {"columns": numeric, "matrix": matrix},
                "importance": importance,
                "confusionMatrix": None,
                "defectLots": [],
                "defectTrend": [],
                "targetColumn": numeric[0],
            }
    except Exception as e:
        return {"success": False, "correlation": {"columns": [], "matrix": []}, "importance": [], "confusionMatrix": None, "error": str(e)}


@router.get("/defect-alerts")
async def get_defect_alerts(limit: int = 50, since: str = None, user=Depends(require_auth)):
    """불량 레포트(lot_defect_reports) 최근 목록. 팝업/알람 내역용. since(ISO 날짜) 이후만 조회 가능."""
    try:
        ensure_lot_defect_reports_table()
        with get_process_connection() as conn:
            with conn.cursor() as cur:
                if since:
                    cur.execute(
                        """SELECT lot_id, timestamp FROM lot_defect_reports
                           WHERE timestamp > %s ORDER BY timestamp DESC LIMIT %s""",
                        (since, limit),
                    )
                else:
                    cur.execute(
                        """SELECT lot_id, timestamp FROM lot_defect_reports
                           ORDER BY timestamp DESC LIMIT %s""",
                        (limit,),
                    )
                rows = cur.fetchall()
                alerts = []
                for row in rows:
                    ts = row.get("timestamp")
                    alerts.append({
                        "id": f"defect_{row['lot_id']}_{(ts.isoformat() if hasattr(ts, 'isoformat') else str(ts))}",
                        "type": "defect",
                        "lot_id": row["lot_id"],
                        "timestamp": ts.isoformat() if hasattr(ts, "isoformat") else str(ts),
                    })
                return {"success": True, "alerts": alerts}
    except Exception as e:
        return {"success": False, "alerts": [], "error": str(e)}


@router.get("/lot-defect-report")
async def get_lot_defect_report(lotId: str = "", user=Depends(require_auth)):
    """LOT 불량 원인 레포트 (스텁: DB/Chroma 미구현 시 빈 응답)."""
    return {"success": True, "reportContent": None, "lotId": lotId}


@router.post("/lot-defect-report")
async def post_lot_defect_report(user=Depends(require_auth)):
    return {"success": True, "message": "FastAPI 백엔드에서는 레포트 생성이 스텁입니다."}


@router.get("/realtime")
async def realtime(user=Depends(require_auth)):
    try:
        with get_process_connection() as conn:
            table = get_process_data_table(conn)
            m = get_process_column_map(conn, table)
            date_col = m["dateCol"]
            numeric = m["numericCols"][:15]
            if not date_col or not numeric:
                return {"success": True, "sensors": []}
            cols_sql = ", ".join(escape_sql_id(c) for c in numeric)
            with conn.cursor() as cur:
                cur.execute(
                    f"SELECT {cols_sql}, {escape_sql_id(date_col)} as ts FROM {escape_sql_id(table)} ORDER BY {escape_sql_id(date_col)} DESC LIMIT 1",
                )
                row = cur.fetchone()
            if not row:
                return {"success": True, "sensors": []}
            sensors = []
            for col in numeric:
                v = row.get(col, 0)
                try:
                    val = float(v or 0)
                except (TypeError, ValueError):
                    val = 0
                sensors.append({
                    "name": col,
                    "nameKorean": col,
                    "currentValue": val,
                    "trend": "stable",
                    "changePercent": 0,
                    "unit": "",
                })
            return {"success": True, "sensors": sensors}
    except Exception as e:
        return {"success": False, "sensors": [], "error": str(e)}
