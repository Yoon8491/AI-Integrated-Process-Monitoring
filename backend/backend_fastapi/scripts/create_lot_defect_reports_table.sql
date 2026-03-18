-- 불량 LOT 알람/레포트 저장용 테이블 (project DB에 생성)
-- HeidiSQL 등에서 project DB 선택 후 이 스크립트 실행

USE project;

CREATE TABLE IF NOT EXISTS lot_defect_reports (
    id INT NOT NULL DEFAULT 0,
    lot_id VARCHAR(100) NOT NULL PRIMARY KEY,
    report_content TEXT NOT NULL,
    lot_data_json JSON,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_id (id),
    INDEX idx_timestamp (timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
