#!/usr/bin/env python3
"""
MariaDB simulation_results를 전처리·모델 파이프라인과 동일하게 처리해
probability를 산출한 뒤, 6개 파라미터와의 상관관계를 분석합니다.

사용법:
  python analyze_probability_correlation.py

  환경변수: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME(또는 PROCESS_DB_NAME)
  .env 파일이 backend/.env에 있으면 로드.
"""

import argparse
import os
import sys

import joblib
import numpy as np
import pandas as pd
from scipy.stats import pearsonr, spearmanr
from sklearn.feature_selection import mutual_info_regression

# .env 로드: minseo/backend/fastapi → 프로젝트 루트 → backend/backend/.env
def _load_env():
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    base = os.path.dirname(os.path.abspath(__file__))
    # fastapi → backend → minseo → 프로젝트루트 (3단계 상위)
    for _ in range(3):
        base = os.path.dirname(base)
    env_path = os.path.join(base, "backend", "backend", ".env")
    if os.path.exists(env_path):
        load_dotenv(env_path)
_load_env()

BASE_FEATURES = [
    "lithium_input",
    "additive_ratio",
    "process_time",
    "humidity",
    "tank_pressure",
    "sintering_temp",
]
TARGETS_REG = ["metal_impurity", "d50"]

# DB 컬럼명 매핑 (export-training-data.ts와 동일)
COLUMN_MAPPING = {
    "lithium_input": ["lithium_input", "lithiuminput", "lithium"],
    "additive_ratio": ["additive_ratio", "additiveratio", "additive"],
    "process_time": ["process_time", "processtime", "processing_time", "duration"],
    "humidity": ["humidity", "moisture"],
    "tank_pressure": ["tank_pressure", "tankpressure", "pressure"],
    "sintering_temp": ["sintering_temp", "sinteringtemp", "sintering_temperature", "temperature", "temp"],
    "metal_impurity": ["metal_impurity", "impurity", "contamination"],
    "d50": ["d50", "D50", "particle_size", "mean_diameter"],
}


def _normalize_col(name: str) -> str:
    return name.lower().replace(" ", "_")


def _find_db_column(db_columns: list[str], target_col: str) -> str | None:
    candidates = COLUMN_MAPPING.get(target_col, [target_col])
    norm_db_cols = [(c, _normalize_col(c)) for c in db_columns]
    for cand in candidates:
        norm_cand = _normalize_col(cand)
        for db_col, norm_db in norm_db_cols:
            if norm_db == norm_cand:
                return db_col
        for db_col, norm_db in norm_db_cols:
            if norm_cand in norm_db or norm_db in norm_cand:
                return db_col
    return None


def _load_from_mariadb(table: str | None = None, limit: int = 10000) -> pd.DataFrame:
    table = table or os.getenv("PROCESS_TABLE_NAME", "simulation_results")
    try:
        import pymysql
    except ImportError:
        print("[Error] pymysql 필요: pip install pymysql")
        sys.exit(1)

    db_config = {
        "host": os.getenv("DB_HOST", "localhost"),
        "port": int(os.getenv("DB_PORT", "3306")),
        "user": os.getenv("DB_USER", "root"),
        "password": os.getenv("DB_PASSWORD", ""),
        "database": os.getenv("PROCESS_DB_NAME", os.getenv("DB_NAME", "factory")),
    }

    if not db_config["password"] and db_config["user"] == "root":
        print("[경고] DB_PASSWORD가 비어 있습니다. backend/backend/.env에서 로드되는지 확인하세요.")
        print("       python-dotenv 설치: pip install python-dotenv")

    conn = pymysql.connect(**db_config)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s ORDER BY ORDINAL_POSITION", (db_config["database"], table))
            db_cols = [r[0] for r in cur.fetchall()]

        col_map = {}
        for target in BASE_FEATURES + TARGETS_REG:
            found = _find_db_column(db_cols, target)
            col_map[target] = found

        select_parts = []
        for target, db_col in col_map.items():
            if db_col:
                select_parts.append(f"`{db_col}` AS `{target}`")
            else:
                select_parts.append(f"NULL AS `{target}`")

        missing = [t for t in BASE_FEATURES if not col_map[t]]
        if missing:
            print(f"[Error] 필수 컬럼 없음: {missing}")
            sys.exit(1)

        sql = f"SELECT {', '.join(select_parts)} FROM `{table}` LIMIT {limit}"
        df = pd.read_sql(sql, conn)
        return df
    finally:
        conn.close()


def compute_probability_correlation(limit: int = 5000, model_path: str | None = None) -> list[dict]:
    """
    전처리+모델 파이프라인으로 probability 산출 후, 6개 파라미터와 Pearson |r| 계산.
    API용: [{ name, importance }, ...] 반환 (importance = |r|, 0~1).
    """
    script_dir = os.path.dirname(os.path.abspath(__file__))
    model_path = model_path or os.path.join(script_dir, "model", "model.joblib")
    if not os.path.exists(model_path):
        raise FileNotFoundError(f"Model not found: {model_path}")

    try:
        df = _load_from_mariadb(limit=limit)
    except Exception as e:
        raise RuntimeError(f"DB load failed: {e}") from e

    bundle = joblib.load(model_path)
    imputer = bundle["imputer"]
    iso = bundle["iso"]
    scaler = bundle["scaler"]
    model = bundle["model"]
    base_features = bundle.get("base_features", BASE_FEATURES)
    targets_reg = bundle.get("targets_reg", TARGETS_REG)
    x_columns = bundle.get("x_columns", [])

    for c in targets_reg:
        if c not in df.columns:
            df[c] = np.nan
    input_matrix = df[base_features + targets_reg].to_numpy(dtype=float)
    try:
        imputed = imputer.transform(input_matrix)
    except Exception:
        imputed = np.nan_to_num(input_matrix, nan=0.0)

    base_array = imputed[:, : len(base_features)]
    target_array = imputed[:, len(base_features) :]
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

    importance = []
    for i, col in enumerate(base_features):
        r, _ = pearsonr(base_array[:, i], probs)
        importance.append({"name": col, "importance": abs(r)})
    importance.sort(key=lambda x: x["importance"], reverse=True)
    return importance


def main():
    parser = argparse.ArgumentParser(description="probability 타겟 6개 파라미터 상관관계 분석 (MariaDB simulation_results)")
    parser.add_argument(
        "--model",
        default="model/model.joblib",
        help="모델 번들 경로",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=10000,
        help="조회 행 수 (기본 10000)",
    )
    parser.add_argument(
        "--csv",
        default=None,
        help="DB 연결 실패 시 사용할 CSV 경로 (예: data/data_sample.csv)",
    )
    args = parser.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    model_path = args.model if os.path.isabs(args.model) else os.path.join(script_dir, args.model)

    if not os.path.exists(model_path):
        print(f"[Error] 모델을 찾을 수 없습니다: {model_path}")
        sys.exit(1)

    # 1. 데이터 로드: MariaDB 우선, 실패 시 CSV
    df = None
    try:
        print("[1] MariaDB simulation_results 조회 중...")
        df = _load_from_mariadb(limit=args.limit)
        print(f"    로드 완료: {len(df)}행")
    except Exception as e:
        csv_path = args.csv or os.path.join(script_dir, "data", "data_sample.csv")
        if os.path.exists(csv_path):
            print(f"[1] DB 연결 실패 ({e}). CSV 사용: {csv_path}")
            df = pd.read_csv(csv_path)
            print(f"    로드 완료: {len(df)}행")
        else:
            print(f"[Error] DB 연결 실패 및 CSV 없음: {csv_path}")
            sys.exit(1)

    # 2. 모델 번들 로드
    bundle = joblib.load(model_path)
    imputer = bundle["imputer"]
    iso = bundle["iso"]
    scaler = bundle["scaler"]
    model = bundle["model"]
    base_features = bundle.get("base_features", BASE_FEATURES)
    targets_reg = bundle.get("targets_reg", TARGETS_REG)

    missing = [c for c in base_features if c not in df.columns]
    if missing:
        print(f"[Error] 필수 컬럼 없음: {missing}")
        sys.exit(1)

    for c in targets_reg:
        if c not in df.columns:
            df[c] = np.nan

    # 3. main.py predict와 동일한 전처리 + 예측
    input_matrix = df[base_features + targets_reg].to_numpy(dtype=float)
    try:
        imputed = imputer.transform(input_matrix)
    except Exception:
        imputed = np.nan_to_num(input_matrix, nan=0.0)

    base_array = imputed[:, : len(base_features)]
    target_array = imputed[:, len(base_features) :]
    anomaly_depth = iso.decision_function(base_array).astype(float)

    feature_frame = pd.concat(
        [
            pd.DataFrame(base_array, columns=base_features),
            pd.DataFrame(target_array, columns=targets_reg),
            pd.DataFrame({"anomaly_depth": anomaly_depth}),
        ],
        axis=1,
    )
    x_columns = bundle.get("x_columns", list(feature_frame.columns))
    if list(feature_frame.columns) != list(x_columns):
        feature_frame = feature_frame.reindex(columns=x_columns)

    X_scaled = scaler.transform(feature_frame)
    probs = model.predict_proba(X_scaled)[:, 1].astype(float)

    print(f"[2] 전처리(imputer+iso)+모델 적용 완료 → probability 산출")

    # 4. 상관관계 분석 (전처리된 6개 파라미터 vs probability)
    print()
    print("=" * 70)
    print("6개 파라미터 vs probability 상관관계 (전처리·모델 파이프라인 동일)")
    print("=" * 70)

    # Pearson
    pearson_vals = {}
    for i, col in enumerate(base_features):
        r, _ = pearsonr(base_array[:, i], probs)
        pearson_vals[col] = abs(r)

    # Spearman
    spearman_vals = {}
    for i, col in enumerate(base_features):
        r, _ = spearmanr(base_array[:, i], probs)
        spearman_vals[col] = abs(r)

    # Mutual Information
    mi_raw = mutual_info_regression(base_array, probs, random_state=42)
    mi_vals = {col: mi_raw[i] for i, col in enumerate(base_features)}
    mi_sum = sum(mi_vals.values())
    mi_norm = {k: v / mi_sum * 100 if mi_sum else 0 for k, v in mi_vals.items()}

    # 결과 출력
    print()
    print("1) Pearson |r| (선형 상관) × 100")
    for col in base_features:
        pct = pearson_vals[col] * 100
        print(f"   {col}: {pct:.2f}%")

    print()
    print("2) Spearman |r| (순위 상관) × 100")
    for col in base_features:
        pct = spearman_vals[col] * 100
        print(f"   {col}: {pct:.2f}%")

    print()
    print("3) Mutual Information 정규화 (합=100%)")
    for col in base_features:
        print(f"   {col}: {mi_norm[col]:.1f}%")

    # 순위
    print()
    print("순위 (Pearson):", [c for c in sorted(base_features, key=lambda x: pearson_vals[x], reverse=True)])
    print("순위 (Spearman):", [c for c in sorted(base_features, key=lambda x: spearman_vals[x], reverse=True)])
    print("순위 (MI):", [c for c in sorted(base_features, key=lambda x: mi_vals[x], reverse=True)])


if __name__ == "__main__":
    main()
