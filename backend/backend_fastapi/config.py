import os

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

PORT = int(os.getenv("PORT", "4000"))
CORS_ORIGIN = os.getenv("CORS_ORIGIN", "https://azas-project.vercel.app")
JWT_SECRET = os.getenv(
    "JWT_SECRET", "manufacturing-dashboard-secret-change-in-production"
)
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_DAYS = 7

# Auth DB (users)
AUTH_DB = {
    "host": os.getenv("AUTH_DB_HOST") or os.getenv("DB_HOST", "localhost"),
    "port": int(os.getenv("AUTH_DB_PORT") or os.getenv("DB_PORT", "3306")),
    "user": os.getenv("AUTH_DB_USER") or os.getenv("DB_USER", "root"),
    "password": os.getenv("AUTH_DB_PASSWORD") or os.getenv("DB_PASSWORD", ""),
    "database": os.getenv("AUTH_DB_NAME") or os.getenv("DB_NAME", "manufacturing_db"),
}

# 공정/대시보드 DB (preprocessing 등)
PROCESS_DB = {
    "host": os.getenv("DB_HOST", "localhost"),
    "port": int(os.getenv("DB_PORT", "3306")),
    "user": os.getenv("DB_USER", "root"),
    "password": os.getenv("DB_PASSWORD", ""),
    "database": os.getenv("PROCESS_DB_NAME") or os.getenv("DB_NAME", "factory"),
}

BACKEND_DATE_TZ = os.getenv("BACKEND_DATE_TZ", "Asia/Seoul")
