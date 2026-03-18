"""
사용자 정의 모델: 8개 feature, 파생변수 없음
Stacking(XGBoost + LightGBM + RandomForest)

MariaDB 연동은 별도 처리 필요
"""

import pandas as pd
import numpy as np
import joblib
from sklearn.preprocessing import RobustScaler
from sklearn.ensemble import RandomForestClassifier, StackingClassifier
from sklearn.linear_model import LogisticRegression
from xgboost import XGBClassifier
from lightgbm import LGBMClassifier
from imblearn.combine import SMOTETomek
from sklearn.model_selection import train_test_split
from sklearn.metrics import recall_score, precision_score, accuracy_score, confusion_matrix, f1_score
from sklearn.experimental import enable_iterative_imputer
from sklearn.impute import IterativeImputer
from sklearn.ensemble import IsolationForest

# ============================================
# PART 1: 전처리 로직
# ============================================

def preprocess_data(df):
    """
    전처리: IQR → MICE → Isolation Forest
    
    입력: df with columns [lot_id, timestamp, operator_id, quality_defect, 
                          lithium_input, additive_ratio, process_time, 
                          humidity, tank_pressure, sintering_temp,
                          metal_impurity, d50]
    출력: (df_final, tools)
    """
    base_features = ['lithium_input', 'additive_ratio', 'process_time', 
                     'humidity', 'tank_pressure', 'sintering_temp']
    targets_reg = ['metal_impurity', 'd50']
    target_cls = 'quality_defect'
    
    # 1. IQR 이원화 전처리
    print("🧹 IQR 1.98(MICE) / 3.0(ffill) 전처리 중...")
    for col in base_features:
        Q1, Q3 = df[col].quantile(0.25), df[col].quantile(0.75)
        IQR = Q3 - Q1
        # 극단 이상치 (3 IQR) → ffill (모든 행에 적용)
        ext_mask = (df[col] < Q1 - 3*IQR) | (df[col] > Q3 + 3*IQR)
        df.loc[ext_mask, col] = np.nan
        df[col] = df[col].ffill()
        # 중간 이상치 (1.98 IQR) → MICE
        mild_mask = (df[col] < Q1 - 1.98*IQR) | (df[col] > Q3 + 1.98*IQR)
        df.loc[mild_mask, col] = np.nan
    
    # 2. MICE 결측치 복구
    print("🤖 MICE 결측치 정밀 복구 중...")
    imputer = IterativeImputer(random_state=42)
    df[base_features + targets_reg] = imputer.fit_transform(df[base_features + targets_reg])
    
    # 3. Isolation Forest 학습 (도구 저장용)
    print("🔍 Isolation Forest 모델 학습 중...")
    iso = IsolationForest(contamination=0.05, random_state=42)
    iso.fit(df[base_features])
    
    # 4. 데이터셋 통합 (파생변수 없이 원본만)
    print("📦 데이터셋 병합 중 (기본 피처만 포함)...")
    df_final = pd.concat([
        df[['lot_id', 'timestamp', 'operator_id', 'quality_defect']].reset_index(drop=True),
        df[base_features].reset_index(drop=True),
        df[targets_reg].reset_index(drop=True)
    ], axis=1)
    
    # 5. 도구 저장
    tools = {
        'imputer': imputer,
        'iso': iso,
        'base_features': base_features,
        'targets_reg': targets_reg
    }
    
    return df_final, tools


# ============================================
# PART 2: 모델 학습 로직
# ============================================

def train_stacking_model(df_final):
    """
    Stacking 모델 학습: XGB + LGBM + RF
    
    입력: df_final (전처리 완료된 데이터)
    출력: (stack_clf, scaler, best_threshold, feature_importance)
    """
    # 1. X, y 분리
    X = df_final.drop(['lot_id', 'timestamp', 'operator_id', 'quality_defect'], axis=1)
    y = df_final['quality_defect']
    
    # 2. 스케일링
    scaler = RobustScaler()
    X_scaled = pd.DataFrame(scaler.fit_transform(X), columns=X.columns)
    
    # 3. 데이터 분할
    X_train, X_test, y_train, y_test = train_test_split(
        X_scaled, y, test_size=0.2, stratify=y, random_state=42
    )
    
    # 4. 밸런싱
    print("🧬 데이터 밸런싱 및 스태킹 모델링 중...")
    smt = SMOTETomek(random_state=42)
    X_train_bal, y_train_bal = smt.fit_resample(X_train, y_train)
    
    # 5. 모델 학습
    estimators = [
        ('xgb', XGBClassifier(n_estimators=400, learning_rate=0.05, max_depth=6, random_state=42)),
        ('lgbm', LGBMClassifier(n_estimators=400, verbose=-1, random_state=42)),
        ('rf', RandomForestClassifier(n_estimators=300, class_weight='balanced', random_state=42))
    ]
    stack_clf = StackingClassifier(
        estimators=estimators,
        final_estimator=LogisticRegression(),
        n_jobs=-1
    )
    stack_clf.fit(X_train_bal, y_train_bal)
    
    # 6. 임계값 최적화 (95% Recall 타겟)
    y_probs = stack_clf.predict_proba(X_test)[:, 1]
    best_th, min_diff = 0.5, 1.0
    for th in np.arange(0.05, 0.8, 0.005):
        diff = abs(recall_score(y_test, (y_probs >= th)) - 0.95)
        if diff < min_diff:
            min_diff, best_th = diff, th
    
    # 7. 최종 성능 평가
    y_pred_final = (y_probs >= best_th).astype(int)
    tn, fp, fn, tp = confusion_matrix(y_test, y_pred_final).ravel()
    
    print("=" * 60)
    print(f"🔥 [최종 성적표] (임계값: {best_th:.4f})")
    print(f"✅ 정확도: {accuracy_score(y_test, y_pred_final):.2%} | 재현율: {recall_score(y_test, y_pred_final):.2%}")
    print(f"✅ 정밀도: {precision_score(y_test, y_pred_final):.2%} | F1: {f1_score(y_test, y_pred_final):.4f}")
    print(f"혼동행렬: tn={tn}, fp={fp}, fn={fn}, tp={tp}")
    print("=" * 60)
    
    # 8. Feature Importance 추출
    feature_importance = extract_feature_importance(stack_clf, X.columns)
    
    return stack_clf, scaler, best_th, feature_importance


def extract_feature_importance(stack_clf, feature_names):
    """
    Stacking 모델의 Feature Importance 추출
    (XGB, LGBM, RF의 평균)
    """
    importances = []
    
    # XGBoost
    if hasattr(stack_clf.estimators_[0], 'feature_importances_'):
        importances.append(stack_clf.estimators_[0].feature_importances_)
    
    # LightGBM
    if hasattr(stack_clf.estimators_[1], 'feature_importances_'):
        importances.append(stack_clf.estimators_[1].feature_importances_)
    
    # RandomForest
    if hasattr(stack_clf.estimators_[2], 'feature_importances_'):
        importances.append(stack_clf.estimators_[2].feature_importances_)
    
    # 평균 계산 및 정규화
    avg_importance = np.mean(importances, axis=0)
    importance_sum = np.sum(avg_importance)
    normalized_importance = (avg_importance / importance_sum).tolist() if importance_sum > 0 else avg_importance.tolist()
    
    return {
        "base_feature_importance": normalized_importance,
        "x_columns": list(feature_names),
        "source": "StackingClassifier(XGB+LGBM+RF) average - 8 features only"
    }


# ============================================
# Feature 목록 (참고용)
# ============================================
"""
최종 Feature 목록 (8개):
1. lithium_input      - 리튬 투입량
2. additive_ratio     - 첨가제 비율
3. process_time       - 공정 시간
4. humidity           - 습도
5. tank_pressure      - 탱크 압력
6. sintering_temp     - 소결 온도
7. metal_impurity     - 금속 불순물
8. d50                - 입자 크기

파생변수 없음! 원본 데이터만 사용!
"""
