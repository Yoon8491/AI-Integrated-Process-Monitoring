-- Grafana 알림 저장용 테이블 (project DB에 생성)
-- HeidiSQL 등에서 project DB 선택 후 이 스크립트 실행

USE project;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
