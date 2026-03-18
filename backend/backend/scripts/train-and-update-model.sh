#!/bin/bash
# 모델 학습 후 feature importance JSON을 백엔드로 복사하는 스크립트
#
# 사용법:
#   ./scripts/train-and-update-model.sh [CSV 경로]
#   예: ./scripts/train-and-update-model.sh ../minseo/backend/fastapi/data/training_export.csv

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MINSEO_DIR="$(cd "$BACKEND_DIR/../../minseo/backend/fastapi" 2>/dev/null && pwd || echo "")"
MODEL_DIR="$BACKEND_DIR/model"

CSV_PATH="${1:-}"
if [ -z "$CSV_PATH" ]; then
  if [ -n "$MINSEO_DIR" ] && [ -f "$MINSEO_DIR/data/training_export.csv" ]; then
    CSV_PATH="$MINSEO_DIR/data/training_export.csv"
    echo "[Train] CSV 경로 자동 설정: $CSV_PATH"
  else
    echo "[Train] ❌ CSV 경로를 지정해주세요."
    echo "사용법: $0 <CSV 경로>"
    exit 1
  fi
fi

if [ ! -f "$CSV_PATH" ]; then
  echo "[Train] ❌ CSV 파일을 찾을 수 없습니다: $CSV_PATH"
  exit 1
fi

echo "[Train] CSV: $CSV_PATH"
echo "[Train] Backend: $BACKEND_DIR"
echo "[Train] Minseo: ${MINSEO_DIR:-'(찾을 수 없음)'}"

# Python 가상환경 확인 (옵션)
if [ -d "$MINSEO_DIR/venv" ]; then
  echo "[Train] Python 가상환경 활성화: $MINSEO_DIR/venv"
  source "$MINSEO_DIR/venv/bin/activate"
elif [ -d "$MINSEO_DIR/.venv" ]; then
  echo "[Train] Python 가상환경 활성화: $MINSEO_DIR/.venv"
  source "$MINSEO_DIR/.venv/bin/activate"
fi

# train_model.py 실행
if [ -z "$MINSEO_DIR" ] || [ ! -f "$MINSEO_DIR/train_model.py" ]; then
  echo "[Train] ❌ train_model.py를 찾을 수 없습니다."
  echo "[Train] minseo/backend/fastapi/train_model.py 경로를 확인해주세요."
  exit 1
fi

echo "[Train] 🚀 모델 학습 시작..."
cd "$MINSEO_DIR"
python3 train_model.py --csv "$CSV_PATH" --output model/model.joblib

if [ ! -f "$MINSEO_DIR/model/model_feature_importance.json" ]; then
  echo "[Train] ❌ model_feature_importance.json이 생성되지 않았습니다."
  exit 1
fi

echo "[Train] ✅ 학습 완료: $MINSEO_DIR/model/model_feature_importance.json"

# 백엔드 model 디렉터리 생성
mkdir -p "$MODEL_DIR"

# JSON 복사
cp "$MINSEO_DIR/model/model_feature_importance.json" "$MODEL_DIR/model_feature_importance.json"
echo "[Train] ✅ JSON 복사 완료: $MODEL_DIR/model_feature_importance.json"

echo ""
echo "[Train] 🎉 완료! 백엔드를 재시작하면 스태킹 모델 중요도가 반영됩니다."
