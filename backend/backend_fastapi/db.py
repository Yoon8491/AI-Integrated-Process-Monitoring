import pymysql
from pymysql import cursors
from pymysql.connections import Connection
from config import AUTH_DB, PROCESS_DB
from contextlib import contextmanager

_auth_pool = []
_process_pool = []
MAX_POOL_SIZE = 5


def _create_auth_connection() -> Connection:
    """인증 DB 연결 생성"""
    return pymysql.connect(
        host=AUTH_DB["host"],
        port=AUTH_DB["port"],
        user=AUTH_DB["user"],
        password=AUTH_DB["password"],
        database=AUTH_DB["database"],
        cursorclass=pymysql.cursors.DictCursor,
        autocommit=False,
    )


def _create_process_connection() -> Connection:
    """공정 DB 연결 생성"""
    return pymysql.connect(
        host=PROCESS_DB["host"],
        port=PROCESS_DB["port"],
        user=PROCESS_DB["user"],
        password=PROCESS_DB["password"],
        database=PROCESS_DB["database"],
        cursorclass=pymysql.cursors.DictCursor,
        autocommit=False,
    )


@contextmanager
def get_auth_connection():
    """인증 DB 연결 컨텍스트 매니저 (연결 풀 사용)"""
    conn = None
    from_pool = False
    try:
        # 풀에서 사용 가능한 연결 찾기
        if _auth_pool:
            conn = _auth_pool.pop()
            from_pool = True
            # 연결이 살아있는지 확인
            try:
                conn.ping(reconnect=True)
            except:
                try:
                    conn.close()
                except:
                    pass
                conn = None
                from_pool = False
        
        # 풀에 연결이 없거나 연결이 끊어진 경우 새로 생성
        if not conn:
            conn = _create_auth_connection()
            from_pool = False
        
        yield conn
        
        # 정상 완료 시 연결을 풀에 반환 (풀이 가득 차지 않은 경우)
        if len(_auth_pool) < MAX_POOL_SIZE:
            try:
                conn.ping(reconnect=True)
                _auth_pool.append(conn)
                conn = None
            except:
                # 연결이 끊어진 경우 닫기
                try:
                    conn.close()
                except:
                    pass
                conn = None
        else:
            # 풀이 가득 찬 경우 연결 닫기
            try:
                conn.close()
            except:
                pass
            conn = None
    except Exception:
        # 예외 발생 시 연결 닫기
        if conn:
            try:
                conn.close()
            except:
                pass
        raise
    finally:
        # 풀에 반환하지 못한 경우 연결 닫기 (안전장치)
        if conn:
            try:
                conn.close()
            except:
                pass


@contextmanager
def get_process_connection():
    """공정 DB 연결 컨텍스트 매니저 (연결 풀 사용)"""
    conn = None
    from_pool = False
    try:
        # 풀에서 사용 가능한 연결 찾기
        if _process_pool:
            conn = _process_pool.pop()
            from_pool = True
            # 연결이 살아있는지 확인
            try:
                conn.ping(reconnect=True)
            except:
                try:
                    conn.close()
                except:
                    pass
                conn = None
                from_pool = False
        
        # 풀에 연결이 없거나 연결이 끊어진 경우 새로 생성
        if not conn:
            conn = _create_process_connection()
            from_pool = False
        
        yield conn
        
        # 정상 완료 시 연결을 풀에 반환 (풀이 가득 차지 않은 경우)
        if len(_process_pool) < MAX_POOL_SIZE:
            try:
                conn.ping(reconnect=True)
                _process_pool.append(conn)
                conn = None
            except:
                # 연결이 끊어진 경우 닫기
                try:
                    conn.close()
                except:
                    pass
                conn = None
        else:
            # 풀이 가득 찬 경우 연결 닫기
            try:
                conn.close()
            except:
                pass
            conn = None
    except Exception:
        # 예외 발생 시 연결 닫기
        if conn:
            try:
                conn.close()
            except:
                pass
        raise
    finally:
        # 풀에 반환하지 못한 경우 연결 닫기 (안전장치)
        if conn:
            try:
                conn.close()
            except:
                pass


def auth_query(sql: str, params=None):
    """인증 DB 쿼리 실행 (레거시 호환)"""
    with get_auth_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params or ())
            if sql.strip().upper().startswith("SELECT"):
                return cur.fetchall()
            conn.commit()
    return None
