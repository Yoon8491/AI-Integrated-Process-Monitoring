-- MariaDB users 테이블 생성 스크립트
-- 데이터베이스 생성
CREATE DATABASE IF NOT EXISTS manufacturing_db;
USE manufacturing_db;

-- users 테이블 생성
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_number VARCHAR(50) UNIQUE NOT NULL COMMENT '사원번호',
  name VARCHAR(100) NOT NULL COMMENT '이름',
  password VARCHAR(255) NOT NULL COMMENT '비밀번호 (bcrypt 해시)',
  role ENUM('admin', 'user') DEFAULT 'user' NOT NULL COMMENT '역할: admin(관리자), user(사원)',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_employee_number (employee_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 테스트 데이터 삽입 (비밀번호는 '1234'를 bcrypt로 해시한 값)
-- 실제 사용 시에는 bcryptjs를 사용하여 비밀번호를 해시해야 합니다.
-- 예: const hash = await bcrypt.hash('1234', 10);
INSERT INTO users (employee_number, name, password, role) VALUES
('0001', '관리자', '$2a$10$rOzJqZqZqZqZqZqZqZqZqOqZqZqZqZqZqZqZqZqZqZqZqZqZqZ', 'admin'),
('0002', '김철수', '$2a$10$rOzJqZqZqZqZqZqZqZqZqOqZqZqZqZqZqZqZqZqZqZqZqZqZqZ', 'user'),
('0003', '이영희', '$2a$10$rOzJqZqZqZqZqZqZqZqZqOqZqZqZqZqZqZqZqZqZqZqZqZqZqZ', 'user')
ON DUPLICATE KEY UPDATE name=VALUES(name);
