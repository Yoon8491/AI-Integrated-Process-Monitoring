# plc_dummy_data.py 기반 OPC UA 서버 (포트 4840)
FROM python:3.11-slim

# 컨테이너 내 .pyc/__pycache__ 생성 방지 (캐시 비우기 불필요하도록)
ENV PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY plc_dummy/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY plc_dummy_data.py /app/plc_dummy_data.py

EXPOSE 4840

CMD ["python", "/app/plc_dummy_data.py"]
