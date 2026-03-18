import datetime
from typing import Optional

import jwt
from config import JWT_ALGORITHM, JWT_EXPIRE_DAYS, JWT_SECRET


def sign_token(payload: dict, expires_days: int = JWT_EXPIRE_DAYS) -> str:
    now = datetime.datetime.utcnow()
    exp = now + datetime.timedelta(days=expires_days)
    data = {**payload, "iat": now, "exp": exp}
    return jwt.encode(data, JWT_SECRET, algorithm=JWT_ALGORITHM)


def verify_token(token: str) -> Optional[dict]:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return {
            "employeeNumber": payload.get("employeeNumber"),
            "name": payload.get("name"),
            "role": payload.get("role", "user"),
        }
    except Exception:
        return None
