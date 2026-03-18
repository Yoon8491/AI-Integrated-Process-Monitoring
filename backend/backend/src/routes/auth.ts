import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { authQuery } from '../db.js';
import { signToken, verifyToken, type JwtPayload } from '../jwt.js';

type UserRow = {
  employee_number: string;
  name: string;
  role: 'admin' | 'user';
  password: string;
};

function validateName(name: string): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = (name || '').trim();
  if (!trimmed) return { ok: false, error: '이름을 입력해주세요.' };
  const isEnglish = /^[A-Za-z\s]+$/.test(trimmed);
  const maxLen = isEnglish ? 10 : 5;
  if (trimmed.length > maxLen) {
    return { ok: false, error: '이름은 한글/기타 최대 5글자, 영어(공백 포함) 최대 10글자까지 가능합니다.' };
  }
  return { ok: true, value: trimmed };
}

export async function registerAuthRoutes(app: FastifyInstance) {
  // 로그인: token + user 반환
  app.post('/api/auth/login', async (request, reply) => {
    const body = request.body as any;
    const employeeNumber = body?.employeeNumber;
    const password = body?.password;

    if (!employeeNumber || !password) {
      return reply.code(400).send({ success: false, error: '사원번호와 비밀번호를 입력해주세요.' });
    }

    const users = (await authQuery<UserRow[]>(
      'SELECT * FROM users WHERE employee_number = ?',
      [employeeNumber]
    )) as any as UserRow[];

    if (!users || users.length === 0) {
      return reply.code(401).send({ success: false, error: '사원번호 또는 비밀번호가 올바르지 않습니다.' });
    }

    const user = users[0];
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return reply.code(401).send({ success: false, error: '사원번호 또는 비밀번호가 올바르지 않습니다.' });
    }

    const userData: JwtPayload = {
      employeeNumber: user.employee_number,
      name: user.name,
      role: user.role,
    };
    const token = await signToken(userData);
    return reply.send({ success: true, token, user: userData });
  });

  // 회원가입
  app.post('/api/auth/signup', async (request, reply) => {
    const body = request.body as any;
    const employeeNumberRaw = body?.employeeNumber;
    const password = body?.password;

    if (!employeeNumberRaw || !String(employeeNumberRaw).trim()) {
      return reply.code(400).send({ success: false, error: '사원번호를 입력해주세요.' });
    }
    if (!password) {
      return reply.code(400).send({ success: false, error: '비밀번호를 입력해주세요.' });
    }
    if (String(password).length < 4) {
      return reply.code(400).send({ success: false, error: '비밀번호는 최소 4자 이상이어야 합니다.' });
    }

    const employeeNumber = String(employeeNumberRaw).trim();
    const existing = (await authQuery<any[]>(
      'SELECT employee_number FROM users WHERE employee_number = ?',
      [employeeNumber]
    )) as any[];
    if (existing?.length) {
      return reply.code(409).send({ success: false, error: '이미 사용 중인 사원번호입니다.' });
    }

    const hashed = await bcrypt.hash(String(password), 10);
    const userName = '사용자';
    try {
      await authQuery(
        'INSERT INTO users (employee_number, name, password, role) VALUES (?, ?, ?, ?)',
        [employeeNumber, userName, hashed, 'user']
      );
      return reply.send({
        success: true,
        message: '회원가입이 완료되었습니다.',
        employeeNumber,
        name: userName,
      });
    } catch (e: any) {
      if (e?.code === 'ER_DUP_ENTRY') {
        return reply.code(409).send({ success: false, error: '이미 존재하는 사원번호입니다. 다시 시도해주세요.' });
      }
      request.log.error(e, 'Signup error');
      return reply.code(500).send({ success: false, error: '회원가입 중 오류가 발생했습니다.' });
    }
  });

  // 이름 변경 (Bearer 필요) + token 재발급
  app.post('/api/auth/update-name', async (request, reply) => {
    const header = request.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return reply.code(401).send({ success: false, error: '로그인이 필요합니다.' });
    }
    const user = await verifyToken(token);
    if (!user) {
      return reply.code(401).send({ success: false, error: '세션이 유효하지 않습니다.' });
    }

    const body = request.body as any;
    const v = validateName(body?.name);
    if (!v.ok) return reply.code(400).send({ success: false, error: v.error });

    await authQuery('UPDATE users SET name = ? WHERE employee_number = ?', [
      v.value,
      user.employeeNumber,
    ]);
    const users = (await authQuery<any[]>(
      'SELECT employee_number, name, role FROM users WHERE employee_number = ?',
      [user.employeeNumber]
    )) as any[];
    if (!users?.length) {
      return reply.code(404).send({ success: false, error: '사용자를 찾을 수 없습니다.' });
    }
    const updated = users[0];
    const updatedUser: JwtPayload = {
      employeeNumber: updated.employee_number,
      name: updated.name,
      role: updated.role,
    };
    const newToken = await signToken(updatedUser);
    return reply.send({ success: true, user: updatedUser, token: newToken });
  });

  // 세션 확인: Authorization Bearer로 user 반환
  app.get('/api/auth/session', async (request, reply) => {
    const header = request.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return reply.send({ user: null });
    }
    const user = await verifyToken(token);
    return reply.send({ user });
  });

  // 로그아웃: Bearer에서는 서버상 상태가 없으므로 성공만 반환
  app.post('/api/auth/logout', async (_request, reply) => {
    return reply.send({ success: true });
  });
}

