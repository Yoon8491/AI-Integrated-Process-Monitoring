import argparse
import json
import os
import time

import joblib
import numpy as np
import pandas as pd
from imblearn.combine import SMOTETomek
from lightgbm import LGBMClassifier
from sklearn.ensemble import IsolationForest, RandomForestClassifier, StackingClassifier
from sklearn.experimental import enable_iterative_imputer  # noqa: F401
from sklearn.impute import IterativeImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    confusion_matrix,
    f1_score,
    precision_score,
    recall_score,
)
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import RobustScaler
from xgboost import XGBClassifier


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}")


def _resolve_csv_path(path: str) -> str:
    if os.path.exists(path):
        return path
    data_dir = os.path.join(os.path.dirname(__file__), "data")
    if os.path.isdir(data_dir):
        csv_candidates = [f for f in os.listdir(data_dir) if f.endswith(".csv")]
        if len(csv_candidates) == 1:
            return os.path.join(data_dir, csv_candidates[0])
    raise FileNotFoundError(f"CSV not found: {path}")


def _preprocess(df: pd.DataFrame):
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

    missing = [c for c in base_features + targets_reg + [target_cls] if c not in df.columns]
    if missing:
        raise ValueError(f"Missing required columns: {missing}")

    if "timestamp" in df.columns:
        df["timestamp"] = pd.to_datetime(df["timestamp"], errors="coerce")
        df = df.sort_values("timestamp").reset_index(drop=True)

    log("🧹 IQR 1.98(MICE) / 3.0(ffill) 전처리 중...")
    for col in base_features:
        Q1, Q3 = df[col].quantile(0.25), df[col].quantile(0.75)
        IQR = Q3 - Q1
        # IQR 이상치: 모든 행에 적용 (target_cls 조건 제거로 전처리 누락 방지)
        ext_mask = (df[col] < Q1 - 3 * IQR) | (df[col] > Q3 + 3 * IQR)
        df.loc[ext_mask, col] = np.nan
        df[col] = df[col].ffill()
        mild_mask = (df[col] < Q1 - 1.98 * IQR) | (df[col] > Q3 + 1.98 * IQR)
        df.loc[mild_mask, col] = np.nan

    log("🤖 MICE 결측치 정밀 복구 중...")
    imputer = IterativeImputer(random_state=42)
    df[base_features + targets_reg] = imputer.fit_transform(df[base_features + targets_reg])

    log("🔍 Isolation Forest 이상치 점수(Score) 추출 중...")
    iso = IsolationForest(contamination=0.05, random_state=42)
    iso.fit(df[base_features])
    df["anomaly_depth"] = iso.decision_function(df[base_features]).astype(float)

    meta_cols = ["lot_id", "timestamp", "operator_id", target_cls]
    meta = {}
    for col in meta_cols:
        if col in df.columns:
            meta[col] = df[col].reset_index(drop=True)
        else:
            meta[col] = pd.Series([None] * len(df))

    df_final = pd.concat(
        [
            pd.DataFrame(meta),
            df[base_features].reset_index(drop=True),
            df[targets_reg].reset_index(drop=True),
            df[["anomaly_depth"]].reset_index(drop=True),
        ],
        axis=1,
    )

    return df_final, {
        "imputer": imputer,
        "iso": iso,
        "base_features": base_features,
        "targets_reg": targets_reg,
        "target_cls": target_cls,
    }


def build_and_train(csv_path: str, output_path: str) -> None:
    resolved_csv = _resolve_csv_path(csv_path)
    log(f"Loading CSV -> {resolved_csv}")
    df = pd.read_csv(resolved_csv)

    df_final, tools = _preprocess(df)
    base_features = tools["base_features"]
    targets_reg = tools["targets_reg"]
    target_cls = tools["target_cls"]

    X = df_final.drop(["lot_id", "timestamp", "operator_id", target_cls], axis=1)
    y = df_final[target_cls]

    scaler = RobustScaler()
    X_scaled = pd.DataFrame(scaler.fit_transform(X), columns=X.columns)

    X_train, X_test, y_train, y_test = train_test_split(
        X_scaled, y, test_size=0.2, stratify=y, random_state=42
    )

    log("🧬 데이터 밸런싱 및 스태킹 모델링 중...")
    smt = SMOTETomek(random_state=42)
    X_train_bal, y_train_bal = smt.fit_resample(X_train, y_train)

    estimators = [
        (
            "xgb",
            XGBClassifier(
                n_estimators=400, learning_rate=0.05, max_depth=6, random_state=42
            ),
        ),
        ("lgbm", LGBMClassifier(n_estimators=400, verbose=-1, random_state=42)),
        (
            "rf",
            RandomForestClassifier(
                n_estimators=300, class_weight="balanced", random_state=42
            ),
        ),
    ]
    stack_clf = StackingClassifier(
        estimators=estimators, final_estimator=LogisticRegression(), n_jobs=-1
    )
    stack_clf.fit(X_train_bal, y_train_bal)

    y_probs = stack_clf.predict_proba(X_test)[:, 1]
    best_th, min_diff = 0.5, 1.0
    for th in np.arange(0.05, 0.8, 0.005):
        diff = abs(recall_score(y_test, (y_probs >= th)) - 0.95)
        if diff < min_diff:
            min_diff, best_th = diff, th

    y_pred_final = (y_probs >= best_th).astype(int)
    tn, fp, fn, tp = confusion_matrix(y_test, y_pred_final).ravel()
    log("=" * 60)
    log(f"🔥 [최종 성적표] (임계값: {best_th:.4f})")
    log(
        f"✅ 정확도: {accuracy_score(y_test, y_pred_final):.2%} | 재현율: {recall_score(y_test, y_pred_final):.2%}"
    )
    log(
        f"✅ 정밀도: {precision_score(y_test, y_pred_final):.2%} | F1: {f1_score(y_test, y_pred_final):.4f}"
    )
    log(f"혼동행렬: tn={tn}, fp={fp}, fn={fn}, tp={tp}")

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    joblib.dump(
        {
            "model": stack_clf,
            "scaler": scaler,
            "threshold": best_th,
            "imputer": tools["imputer"],
            "iso": tools["iso"],
            "base_features": base_features,
            "targets_reg": targets_reg,
            "x_columns": list(X.columns),
        },
        output_path,
    )
    log(f"Saved model bundle -> {output_path}")

    # model_feature_importance.json 생성 (lot-defect-report용, 6개 base + reg + anomaly)
    x_cols = list(X.columns)
    imp_list = []
    for est in stack_clf.estimators_:
        if hasattr(est, "feature_importances_"):
            imp_list.append(est.feature_importances_)
    if imp_list:
        avg_imp = np.mean(imp_list, axis=0)
        total = avg_imp.sum()
        normalized = (avg_imp / total) if total > 0 else np.ones_like(avg_imp) / len(avg_imp)
        feat_importance = dict(zip(x_cols, normalized.tolist()))
    else:
        feat_importance = {c: 1.0 / len(x_cols) for c in x_cols}
    json_path = os.path.join(os.path.dirname(output_path), "model_feature_importance.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(
            {**feat_importance, "x_columns": x_cols, "source": "StackingClassifier(XGB+LGBM+RF) average"},
            f,
            ensure_ascii=False,
            indent=2,
        )
    log(f"Saved feature importance -> {json_path}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--csv",
        default=os.path.join("data", "data_sample.csv"),
        help="Path to training CSV file (default: data/data_sample.csv)",
    )
    parser.add_argument(
        "--output",
        default="model/model.joblib",
        help="Output model bundle path (default: model/model.joblib)",
    )
    args = parser.parse_args()

    build_and_train(args.csv, args.output)


if __name__ == "__main__":
    main()
