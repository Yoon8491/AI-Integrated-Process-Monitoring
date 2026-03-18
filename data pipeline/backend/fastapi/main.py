import os
import re
import threading
from typing import Any, Dict, List, Optional, Tuple

import joblib
import numpy as np
import pandas as pd
from fastapi import FastAPI
from pydantic import BaseModel
from sklearn.experimental import enable_iterative_imputer  # noqa: F401
from sklearn.ensemble import IsolationForest
from sklearn.impute import IterativeImputer, SimpleImputer

app = FastAPI()

BASE_FEATURES = [
    "lithium_input",
    "additive_ratio",
    "process_time",
    "humidity",
    "tank_pressure",
    "sintering_temp",
]
DATA_SAMPLE_COLUMN_MAPPING = {
    "lithium_input": ["lithium_input", "lithiuminput", "lithium"],
    "additive_ratio": ["additive_ratio", "additiveratio", "additive"],
    "process_time": ["process_time", "processtime", "processing_time", "duration"],
    "humidity": ["humidity", "moisture"],
    "tank_pressure": ["tank_pressure", "tankpressure", "pressure"],
    "sintering_temp": ["sintering_temp", "sinteringtemp", "sintering_temperature", "temperature", "temp"],
}

_iqr_bounds_cache: Optional[Dict[str, Tuple[float, float, float]]] = None
_iqr_cache_lock = threading.Lock()

MODEL_PATH = os.getenv(
    "MODEL_PATH",
    "/home/ubuntu/kimminseo/backend/fastapi/model/model.joblib",
)
MODEL_DIR = os.getenv("MODEL_DIR", "/app/model")
_model = None
_model_mtime = None
_model_path = MODEL_PATH
_model_lock = threading.Lock()


class PredictRequest(BaseModel):
    data: Optional[Dict[str, Any]] = None
    features: Optional[List[float]] = None
    items: Optional[List[Dict[str, Any]]] = None
    model_id: Optional[str] = None


class PreprocessRequest(BaseModel):
    items: List[Dict[str, Any]]
    model_id: Optional[str] = None


def _resolve_model_path(model_id: Optional[str]) -> str:
    if not model_id:
        return MODEL_PATH
    if not re.fullmatch(r"[A-Za-z0-9._-]+", model_id):
        raise ValueError("invalid_model_id")
    return os.path.join(MODEL_DIR, f"{model_id}.joblib")


def _find_data_sample_column(db_columns: List[str], target_col: str) -> Optional[str]:
    """data_sample 테이블 컬럼 중 target_col에 대응하는 실제 컬럼명 찾기."""
    candidates = DATA_SAMPLE_COLUMN_MAPPING.get(target_col, [target_col])
    norm_db = {c: c.lower().replace(" ", "_") for c in db_columns}
    for cand in candidates:
        norm_cand = cand.lower().replace(" ", "_")
        for db_col, norm in norm_db.items():
            if norm == norm_cand or norm_cand in norm or norm in norm_cand:
                return db_col
    return None


def _get_iqr_bounds_from_data_sample() -> Optional[Dict[str, Tuple[float, float, float]]]:
    """
    MariaDB data_sample 테이블에서 Q1, Q3, IQR 계산.
    반환: {col: (Q1, Q3, IQR)} 또는 DB 실패 시 None.
    """
    global _iqr_bounds_cache
    with _iqr_cache_lock:
        if _iqr_bounds_cache is not None:
            return _iqr_bounds_cache

    try:
        import pymysql
    except ImportError:
        return None

    db_name = os.getenv("COMPARISON_DB_NAME", os.getenv("PROCESS_DB_NAME", os.getenv("DB_NAME", "factory")))
    table = os.getenv("COMPARISON_TABLE_NAME", "data_sample").strip()
    db_config = {
        "host": os.getenv("DB_HOST", "localhost"),
        "port": int(os.getenv("DB_PORT", "3306")),
        "user": os.getenv("DB_USER", "root"),
        "password": os.getenv("DB_PASSWORD", ""),
        "database": db_name,
    }
    try:
        conn = pymysql.connect(**db_config)
    except Exception:
        return None

    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COLUMN_NAME FROM information_schema.COLUMNS "
                "WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s ORDER BY ORDINAL_POSITION",
                (db_name, table),
            )
            db_cols = [r[0] for r in cur.fetchall()]

        col_map = {}
        for target in BASE_FEATURES:
            found = _find_data_sample_column(db_cols, target)
            if found:
                col_map[target] = found

        if len(col_map) == 0:
            return None

        select_parts = [f"`{db_col}` AS `{target}`" for target, db_col in col_map.items()]
        sql = f"SELECT {', '.join(select_parts)} FROM `{table}` LIMIT 50000"
        df = pd.read_sql(sql, conn)

        bounds: Dict[str, Tuple[float, float, float]] = {}
        for col in BASE_FEATURES:
            if col not in df.columns:
                continue
            series = pd.to_numeric(df[col], errors="coerce").dropna()
            if len(series) < 4:
                continue
            Q1 = float(series.quantile(0.25))
            Q3 = float(series.quantile(0.75))
            iqr = Q3 - Q1
            if iqr <= 0:
                iqr = 1e-9
            bounds[col] = (Q1, Q3, iqr)

        with _iqr_cache_lock:
            _iqr_bounds_cache = bounds  # 빈 dict도 캐시해 DB 재조회 방지
        return _iqr_bounds_cache
    except Exception:
        return None
    finally:
        conn.close()


def load_model(path: Optional[str] = None, force: bool = False) -> Optional[dict]:
    global _model, _model_mtime, _model_path
    target_path = path or MODEL_PATH
    if not os.path.exists(target_path):
        return None
    mtime = os.path.getmtime(target_path)
    with _model_lock:
        if force or _model is None or _model_path != target_path or _model_mtime != mtime:
            try:
                loaded_model = joblib.load(target_path)
            except Exception as exc:
                print(f"Failed to load model from {target_path}: {exc}")
                return _model
            _model = loaded_model
            _model_mtime = mtime
            _model_path = target_path
    return _model


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/api/probability-correlation")
def get_probability_correlation(limit: int = 5000):
    """
    전처리+모델 파이프라인 기반 6개 파라미터 vs probability Pearson |r|.
    대시보드 '불량 영향 변수 Top 6'용.
    """
    try:
        from analyze_probability_correlation import compute_probability_correlation
        importance = compute_probability_correlation(limit=limit)
        return {
            "success": True,
            "importance": importance,
            "targetColumn": "probability",
        }
    except FileNotFoundError as e:
        return {"success": False, "error": str(e)}
    except RuntimeError as e:
        return {"success": False, "error": str(e)}
    except Exception as e:
        return {"success": False, "error": str(e)}


@app.post("/predict")
def predict(payload: PredictRequest):
    try:
        model_path = _resolve_model_path(payload.model_id)
    except ValueError as exc:
        return {"error": str(exc)}

    model_bundle = load_model(model_path)
    if model_bundle is None:
        return {"error": "model_not_loaded"}

    base_features = model_bundle.get("base_features")
    targets_reg = model_bundle.get("targets_reg", [])
    iso = model_bundle.get("iso")
    scaler = model_bundle.get("scaler")
    model = model_bundle.get("model")
    best_threshold = model_bundle.get("threshold", 0.5)
    x_columns = model_bundle.get("x_columns", [])
    imputer = model_bundle.get("imputer")

    if not all([base_features, iso, scaler, model, x_columns, imputer]):
        return {"error": "model_bundle_missing_keys"}

    try:
        required_inputs = list(base_features)
        if payload.items:
            items = payload.items
        elif payload.data:
            items = [payload.data]
        elif payload.features:
            if len(payload.features) != len(required_inputs) + len(targets_reg):
                return {
                    "error": "feature_length_mismatch",
                    "expected": len(required_inputs) + len(targets_reg),
                    "actual": len(payload.features),
                }
            values = payload.features
            items = [
                {**dict(zip(required_inputs, values[: len(required_inputs)])),
                 **dict(zip(targets_reg, values[len(required_inputs) :]))}
            ]
        else:
            return {"error": "no_input_data"}

        df = pd.DataFrame(items)
        missing_base = [c for c in required_inputs if c not in df.columns]
        if missing_base:
            return {"error": "missing_features", "missing": missing_base}
        for col in targets_reg:
            if col not in df.columns:
                df[col] = np.nan

        input_matrix = df[required_inputs + targets_reg].to_numpy(dtype=float)
        try:
            imputed = imputer.transform(input_matrix)
        except Exception:
            imputed = np.nan_to_num(input_matrix, nan=0.0)

        base_array = imputed[:, : len(base_features)]
        target_array = imputed[:, len(base_features) :]
        imputed_targets = [
            dict(zip(targets_reg, target_array[row_idx])) for row_idx in range(len(items))
        ]

        anomaly_depth = iso.decision_function(base_array).astype(float)

        feature_frame = pd.concat(
            [
                pd.DataFrame(base_array, columns=base_features),
                pd.DataFrame(target_array, columns=targets_reg),
                pd.DataFrame({"anomaly_depth": anomaly_depth}),
            ],
            axis=1,
        )

        if list(feature_frame.columns) != list(x_columns):
            feature_frame = feature_frame.reindex(columns=x_columns)
        X_scaled = scaler.transform(feature_frame)

        probs = model.predict_proba(X_scaled)[:, 1].astype(float)
        preds = (probs >= best_threshold).astype(int)

        def _get_value(src: Dict[str, Any], key: str, fallback: float) -> float:
            value = src.get(key)
            if value is None:
                return float(fallback)
            if isinstance(value, float) and np.isnan(value):
                return float(fallback)
            return float(value)

        results = []
        for idx, src in enumerate(items):
            results.append(
                {
                    "prediction": int(preds[idx]),
                    "probability": float(probs[idx]),
                    "predict_availability": float(probs[idx]),
                    "lot_id": src.get("lot_id"),
                    "timestamp": src.get("timestamp"),
                    "operator_id": src.get("operator_id"),
                    "lithium_input": src.get("lithium_input"),
                    "additive_ratio": src.get("additive_ratio"),
                    "process_time": src.get("process_time"),
                    "humidity": src.get("humidity"),
                    "tank_pressure": src.get("tank_pressure"),
                    "sintering_temp": src.get("sintering_temp"),
                    "metal_impurity": _get_value(
                        src, "metal_impurity", imputed_targets[idx]["metal_impurity"]
                    ),
                    "d50": _get_value(src, "d50", imputed_targets[idx]["d50"]),
                }
            )

        if payload.items:
            return {"items": results}
        return results[0]
    except KeyError as exc:
        return {"error": "missing_key", "message": str(exc)}
    except ValueError as exc:
        return {"error": "value_error", "message": str(exc)}
    except ZeroDivisionError:
        return {"error": "zero_division", "message": "division by zero in features"}
    except TypeError as exc:
        return {"error": "type_error", "message": str(exc)}
    except Exception as exc:
        return {"error": "predict_failed", "message": str(exc)}


@app.post("/preprocess")
def preprocess(payload: PreprocessRequest):
    # 1. 기본 설정
    base_features = [
        "lithium_input",
        "additive_ratio",
        "process_time",
        "humidity",
        "tank_pressure",
        "sintering_temp",
    ]
    targets_reg = ["metal_impurity", "d50"]
    target_cls = "quality_defect"

    if not payload.items:
        return {"error": "no_items"}

    # 2. 모델 번들 로드
    model_bundle = None
    try:
        model_path = _resolve_model_path(payload.model_id)
        model_bundle = load_model(model_path)
    except Exception:
        pass 

    # 3. 데이터프레임 변환 및 전처리 준비
    df = pd.DataFrame(payload.items)
    
    # 필수 컬럼 보장
    if target_cls not in df.columns:
        df[target_cls] = 0
    for col in base_features + targets_reg:
        if col not in df.columns:
            df[col] = np.nan

    # 4. IQR 이원화 전처리 (data_sample 기준 이상치 판별, 없으면 배치 기준 fallback)
    iqr_bounds = _get_iqr_bounds_from_data_sample()
    for col in base_features:
        if df[col].isna().all():
            continue
        if iqr_bounds and col in iqr_bounds:
            Q1, Q3, IQR = iqr_bounds[col]
        else:
            q1_val = df[col].quantile(0.25)
            q3_val = df[col].quantile(0.75)
            Q1, Q3 = float(q1_val), float(q3_val)
            IQR = Q3 - Q1
            if IQR <= 0:
                IQR = 1e-9

        # 3.0 IQR 초과: ffill (모든 행에 적용해 전처리가 누락되지 않도록 함)
        ext_mask = (df[col] < Q1 - 3 * IQR) | (df[col] > Q3 + 3 * IQR)
        df.loc[ext_mask, col] = np.nan
        df[col] = df[col].ffill()

        # 1.98 IQR 초과: MICE 대상
        mild_mask = (df[col] < Q1 - 1.98 * IQR) | (df[col] > Q3 + 1.98 * IQR)
        df.loc[mild_mask, col] = np.nan

    # 5. MICE 결측치 복구
    mice_cols = base_features + targets_reg
    matrix = df[mice_cols].values
    
    try:
        if model_bundle and model_bundle.get("imputer"):
            imputer = model_bundle["imputer"]
            imputed = imputer.transform(matrix)
        else:
            imputer = IterativeImputer(random_state=42)
            imputed = imputer.fit_transform(matrix)
    except Exception:
        imputed = np.nan_to_num(matrix, nan=0.0)

    # 6. 결과 조립 (불필요한 타겟 컬럼 제외 버전)
    results = []
    for row_idx, original_row in enumerate(payload.items):
        # 1. 전처리된 6가지 기본 공정 데이터만 추출
        cleaned_row = {col: float(imputed[row_idx, col_idx]) for col_idx, col in enumerate(base_features)}
    
        # 2. 식별 정보 및 운영자 정보 매핑
        cleaned_row["lot_id"] = str(original_row.get("lot_id", ""))
        cleaned_row["timestamp"] = str(original_row.get("timestamp", ""))
        cleaned_row["operator_id"] = str(original_row.get("operator_id", "no_data"))
    
        # 3. 이상치 점수 (이건 공정 상태 확인을 위해 포함하는 것이 좋습니다)
        if model_bundle and model_bundle.get("iso"):
            iso = model_bundle["iso"]
            base_data = np.array([[cleaned_row[f] for f in base_features]])
            cleaned_row["anomaly_depth"] = float(iso.decision_function(base_data)[0])
        else:
            cleaned_row["anomaly_depth"] = 0.0
    
        results.append(cleaned_row)

    return {"items": results}

load_model()