"""Grafana webhook 수신 및 알림 관리."""
from fastapi import APIRouter, Request, HTTPException, Header
from datetime import datetime
from typing import Dict, List, Optional, Any
import json
import os
from db import get_process_connection

router = APIRouter(prefix="/api/grafana", tags=["grafana"])


def _safe_json(val: Any) -> dict:
    """DB JSON 컬럼이 str이거나 이미 dict일 수 있음."""
    if val is None:
        return {}
    if isinstance(val, dict):
        return val
    if isinstance(val, str):
        try:
            return json.loads(val) if val.strip() else {}
        except Exception:
            return {}
    return {}

# Webhook secret (환경변수에서 가져오거나 기본값 사용)
WEBHOOK_SECRET = os.getenv("GRAFANA_WEBHOOK_SECRET", "")


def ensure_grafana_alerts_table():
    """grafana_alerts 테이블이 없으면 생성. PROCESS_DB(현재 사용 중인 project DB)에 생성됨."""
    with get_process_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS grafana_alerts (
                    id VARCHAR(255) NOT NULL PRIMARY KEY,
                    status VARCHAR(20) NOT NULL,
                    alertname VARCHAR(255) NOT NULL,
                    grafana_folder VARCHAR(255),
                    host VARCHAR(255),
                    title TEXT NOT NULL,
                    description TEXT,
                    labels JSON,
                    annotations JSON,
                    `values` JSON,
                    timestamp DATETIME NOT NULL,
                    received_at DATETIME NOT NULL,
                    INDEX idx_status (status),
                    INDEX idx_timestamp (timestamp),
                    INDEX idx_alertname (alertname)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            """)
            conn.commit()


@router.post("/webhook")
async def grafana_webhook(
    request: Request,
    authorization: Optional[str] = Header(None),
):
    """Grafana webhook을 받아서 알림을 MariaDB에 저장.
    
    보안: WEBHOOK_SECRET이 설정되어 있으면 Authorization 헤더로 검증합니다.
    Grafana에서 webhook 설정 시 HTTP Header에 Authorization: Bearer {WEBHOOK_SECRET} 추가 필요.
    """
    # Webhook secret 검증 (설정된 경우)
    if WEBHOOK_SECRET:
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Missing or invalid authorization header")
        token = authorization.replace("Bearer ", "").strip()
        if token != WEBHOOK_SECRET:
            raise HTTPException(status_code=403, detail="Invalid webhook secret")
    
    try:
        body = await request.json()
        
        # 로깅: webhook 수신 확인
        print(f"[Grafana Webhook] Received webhook at {datetime.now().isoformat()}")
        print(f"[Grafana Webhook] Body keys: {list(body.keys())}")
        
        # 테이블 생성 확인
        ensure_grafana_alerts_table()
        
        # Grafana webhook 형식 처리 (version 1 또는 4, 또는 data.alerts 래핑)
        version = body.get("version", "1")
        alerts = body.get("alerts")
        if alerts is None and isinstance(body.get("data"), dict):
            alerts = body.get("data").get("alerts")
        if not isinstance(alerts, list):
            alerts = []
        
        print(f"[Grafana Webhook] Version: {version}, Alerts count: {len(alerts)}")
        
        if not alerts:
            print("[Grafana Webhook] No alerts in webhook body")
            return {"success": True, "message": "No alerts in webhook"}
        
        new_alerts = []
        for alert in alerts:
            # 알림 정보 추출
            status = alert.get("status", "unknown")  # firing, resolved
            labels = alert.get("labels", {})
            annotations = alert.get("annotations", {})
            values = alert.get("values", {})
            
            alert_name = labels.get("alertname", "Unknown Alert")
            grafana_folder = labels.get("grafana_folder", "")
            host = labels.get("host", "")
            
            # 알림 메시지 구성
            title = annotations.get("summary", alert_name)
            description = annotations.get("description", "")
            
            # 알림 ID 생성: alertname + host 조합으로 고유 ID 생성 (같은 알림은 같은 ID)
            alert_id = f"{alert_name}_{host}".replace(" ", "_").replace("/", "_")
            
            # MariaDB에 저장
            try:
                ensure_grafana_alerts_table()
                with get_process_connection() as conn:
                    with conn.cursor() as cur:
                        # 같은 ID의 알림이 있는지 확인
                        cur.execute("SELECT id, status FROM grafana_alerts WHERE id = %s LIMIT 1", (alert_id,))
                        existing = cur.fetchone()
                        
                        now = datetime.now()
                        
                        if existing:
                            # 기존 알림 업데이트
                            cur.execute("""
                                UPDATE grafana_alerts SET
                                    status = %s,
                                    title = %s,
                                    description = %s,
                                    labels = %s,
                                    annotations = %s,
                                    `values` = %s,
                                    timestamp = %s,
                                    received_at = %s
                                WHERE id = %s
                            """, (
                                status,
                                title,
                                description,
                                json.dumps(labels),
                                json.dumps(annotations),
                                json.dumps(values),
                                now,
                                now,
                                alert_id
                            ))
                            print(f"[Grafana Webhook] Updated alert in DB: {alert_name} ({status}) from {host}")
                        else:
                            # 새 알림 삽입
                            cur.execute("""
                                INSERT INTO grafana_alerts 
                                (id, status, alertname, grafana_folder, host, title, description, labels, annotations, `values`, timestamp, received_at)
                                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                            """, (
                                alert_id,
                                status,
                                alert_name,
                                grafana_folder,
                                host,
                                title,
                                description,
                                json.dumps(labels),
                                json.dumps(annotations),
                                json.dumps(values),
                                now,
                                now
                            ))
                            print(f"[Grafana Webhook] Inserted new alert to DB: {alert_name} ({status}) from {host}")
                        
                        conn.commit()
                        
                        # 응답용 데이터 구성
                        alert_data = {
                            "id": alert_id,
                            "status": status,
                            "alertname": alert_name,
                            "grafana_folder": grafana_folder,
                            "host": host,
                            "title": title,
                            "description": description,
                            "labels": labels,
                            "annotations": annotations,
                            "values": values,
                            "timestamp": now.isoformat(),
                            "received_at": now.isoformat(),
                        }
                        new_alerts.append(alert_data)
            except Exception as db_error:
                print(f"[Grafana Webhook] DB error: {str(db_error)}")
                import traceback
                traceback.print_exc()
                # DB 저장 실패해도 계속 진행
        
        return {
            "success": True,
            "message": f"Received {len(new_alerts)} alerts",
            "alerts_count": len(new_alerts),
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


@router.get("/alerts")
async def get_grafana_alerts(limit: int = 20, status: Optional[str] = None):
    """최근 Grafana 알림 조회 (MariaDB에서)."""
    try:
        ensure_grafana_alerts_table()
        
        with get_process_connection() as conn:
            with conn.cursor() as cur:
                # 상태 필터링 쿼리 구성
                where_clause = ""
                params = []
                if status:
                    where_clause = "WHERE status = %s"
                    params.append(status)
                
                # 전체 개수 조회
                count_query = f"SELECT COUNT(*) as total FROM grafana_alerts {where_clause}"
                cur.execute(count_query, params)
                total_result = cur.fetchone()
                total = total_result['total'] if total_result else 0
                
                # firing 개수 조회
                cur.execute("SELECT COUNT(*) as count FROM grafana_alerts WHERE status = 'firing'")
                firing_result = cur.fetchone()
                firing_count = firing_result['count'] if firing_result else 0
                
                # 알림 목록 조회
                query = f"""
                    SELECT 
                        id, status, alertname, grafana_folder, host, title, description,
                        labels, annotations, `values`,
                        timestamp, received_at
                    FROM grafana_alerts
                    {where_clause}
                    ORDER BY timestamp DESC
                    LIMIT %s
                """
                params.append(limit)
                cur.execute(query, params)
                rows = cur.fetchall()
                
                # JSON 필드 파싱 (MariaDB JSON 컬럼은 str 또는 dict로 올 수 있음)
                alerts = []
                for row in rows:
                    alert = {
                        "id": row["id"],
                        "status": row["status"],
                        "alertname": row["alertname"],
                        "grafana_folder": row.get("grafana_folder"),
                        "host": row.get("host"),
                        "title": row["title"],
                        "description": row.get("description"),
                        "labels": _safe_json(row.get("labels")),
                        "annotations": _safe_json(row.get("annotations")),
                        "values": _safe_json(row.get("values")),
                        "timestamp": row["timestamp"].isoformat() if hasattr(row["timestamp"], 'isoformat') else str(row["timestamp"]),
                        "received_at": row["received_at"].isoformat() if hasattr(row["received_at"], 'isoformat') else str(row["received_at"]),
                    }
                    alerts.append(alert)
        
        return {
            "success": True,
            "alerts": alerts,
            "total": total,
            "firing_count": firing_count,
        }
    except Exception as e:
        print(f"[Grafana Alerts API] Error: {str(e)}")
        return {"success": False, "error": str(e), "alerts": []}


@router.get("/alerts/latest")
async def get_latest_grafana_alerts(since: Optional[str] = None):
    """since 이후의 새로운 알림만 조회 (폴링용, MariaDB에서)."""
    try:
        ensure_grafana_alerts_table()
        
        with get_process_connection() as conn:
            with conn.cursor() as cur:
                # since 이후의 firing 알림만 조회
                if since:
                    query = """
                        SELECT 
                            id, status, alertname, grafana_folder, host, title, description,
                            labels, annotations, `values`,
                            timestamp, received_at
                        FROM grafana_alerts
                        WHERE status = 'firing' AND timestamp > %s
                        ORDER BY timestamp DESC
                    """
                    cur.execute(query, (since,))
                else:
                    query = """
                        SELECT 
                            id, status, alertname, grafana_folder, host, title, description,
                            labels, annotations, `values`,
                            timestamp, received_at
                        FROM grafana_alerts
                        WHERE status = 'firing'
                        ORDER BY timestamp DESC
                        LIMIT 20
                    """
                    cur.execute(query)
                
                rows = cur.fetchall()
                
                # 최신 타임스탬프 조회
                cur.execute("SELECT MAX(timestamp) as latest FROM grafana_alerts")
                latest_result = cur.fetchone()
                latest_timestamp = latest_result['latest'].isoformat() if latest_result and latest_result['latest'] else None
                
                # JSON 필드 파싱
                firing_alerts = []
                for row in rows:
                    alert = {
                        "id": row["id"],
                        "status": row["status"],
                        "alertname": row["alertname"],
                        "grafana_folder": row.get("grafana_folder"),
                        "host": row.get("host"),
                        "title": row["title"],
                        "description": row.get("description"),
                        "labels": _safe_json(row.get("labels")),
                        "annotations": _safe_json(row.get("annotations")),
                        "values": _safe_json(row.get("values")),
                        "timestamp": row["timestamp"].isoformat() if hasattr(row["timestamp"], 'isoformat') else str(row["timestamp"]),
                        "received_at": row["received_at"].isoformat() if hasattr(row["received_at"], 'isoformat') else str(row["received_at"]),
                    }
                    firing_alerts.append(alert)
        
        return {
            "success": True,
            "alerts": firing_alerts,
            "latest_timestamp": latest_timestamp,
        }
    except Exception as e:
        print(f"[Grafana Alerts Latest API] Error: {str(e)}")
        return {"success": False, "error": str(e), "alerts": []}
