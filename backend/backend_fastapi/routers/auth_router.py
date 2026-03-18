from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
import bcrypt

from db import auth_query
from auth_jwt import sign_token, verify_token

router = APIRouter(prefix="/api/auth", tags=["auth"])
security = HTTPBearer(auto_error=False)


class LoginBody(BaseModel):
    employeeNumber: str
    password: str


class SignupBody(BaseModel):
    employeeNumber: str
    password: str


class UpdateNameBody(BaseModel):
    name: str


def validate_name(name: str) -> tuple[bool, str, str]:
    trimmed = (name or "").strip()
    if not trimmed:
        return False, "이름을 입력해주세요.", ""
    is_english = all(c.isascii() and (c.isalpha() or c.isspace()) for c in trimmed)
    max_len = 10 if is_english else 5
    if len(trimmed) > max_len:
        return False, "이름은 한글/기타 최대 5글자, 영어(공백 포함) 최대 10글자까지 가능합니다.", ""
    return True, "", trimmed


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
):
    if not credentials or credentials.scheme != "Bearer" or not credentials.credentials:
        return None
    return verify_token(credentials.credentials)


@router.post("/login")
async def login(body: LoginBody):
    if not body.employeeNumber or not body.password:
        raise HTTPException(status_code=400, detail="사원번호와 비밀번호를 입력해주세요.")
    rows = auth_query("SELECT * FROM users WHERE employee_number = %s", (body.employeeNumber,))
    if not rows:
        raise HTTPException(status_code=401, detail="사원번호 또는 비밀번호가 올바르지 않습니다.")
    user = rows[0]
    pw = user["password"]
    pw_b = pw.encode("utf-8") if isinstance(pw, str) else pw
    if not bcrypt.checkpw(body.password.encode("utf-8"), pw_b):
        raise HTTPException(status_code=401, detail="사원번호 또는 비밀번호가 올바르지 않습니다.")
    user_data = {
        "employeeNumber": user["employee_number"],
        "name": user["name"],
        "role": user["role"] or "user",
    }
    token = sign_token(user_data)
    return {"success": True, "token": token, "user": user_data}


@router.post("/signup")
async def signup(body: SignupBody):
    if not (body.employeeNumber or "").strip():
        raise HTTPException(status_code=400, detail="사원번호를 입력해주세요.")
    if not body.password:
        raise HTTPException(status_code=400, detail="비밀번호를 입력해주세요.")
    if len(body.password) < 4:
        raise HTTPException(status_code=400, detail="비밀번호는 최소 4자 이상이어야 합니다.")
    emp = str(body.employeeNumber).strip()
    existing = auth_query("SELECT employee_number FROM users WHERE employee_number = %s", (emp,))
    if existing:
        raise HTTPException(status_code=409, detail="이미 사용 중인 사원번호입니다.")
    hashed = bcrypt.hashpw(body.password.encode("utf-8"), bcrypt.gensalt(rounds=10)).decode("utf-8")
    try:
        auth_query(
            "INSERT INTO users (employee_number, name, password, role) VALUES (%s, %s, %s, %s)",
            (emp, "사용자", hashed, "user"),
        )
        return {"success": True, "message": "회원가입이 완료되었습니다.", "employeeNumber": emp, "name": "사용자"}
    except Exception as e:
        if "Duplicate" in str(e) or "ER_DUP_ENTRY" in str(e):
            raise HTTPException(status_code=409, detail="이미 존재하는 사원번호입니다. 다시 시도해주세요.")
        raise HTTPException(status_code=500, detail="회원가입 중 오류가 발생했습니다.")


@router.post("/update-name")
async def update_name(body: UpdateNameBody, user=Depends(get_current_user)):
    if not user:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    ok, err, value = validate_name(body.name)
    if not ok:
        raise HTTPException(status_code=400, detail=err)
    auth_query("UPDATE users SET name = %s WHERE employee_number = %s", (value, user["employeeNumber"]))
    rows = auth_query(
        "SELECT employee_number, name, role FROM users WHERE employee_number = %s",
        (user["employeeNumber"],),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다.")
    updated = rows[0]
    updated_user = {
        "employeeNumber": updated["employee_number"],
        "name": updated["name"],
        "role": updated["role"] or "user",
    }
    new_token = sign_token(updated_user)
    return {"success": True, "user": updated_user, "token": new_token}


@router.get("/session")
async def session(user=Depends(get_current_user)):
    return {"user": user}


@router.post("/logout")
async def logout():
    return {"success": True}
