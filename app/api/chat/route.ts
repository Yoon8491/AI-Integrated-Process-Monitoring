import { NextRequest, NextResponse } from 'next/server';
import { getBackendUrl } from '@/lib/backend-url';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 챗봇 API 프록시 라우트
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const backendUrl = getBackendUrl();
    const authHeader = request.headers.get('authorization');

    const response = await fetch(`${backendUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: JSON.stringify(body),
    });

    const backendCT = response.headers.get('Content-Type') || '';
    const isSSE = backendCT.includes('text/event-stream');

    if (body.stream && isSSE && response.ok && response.body) {
      return new Response(response.body, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return NextResponse.json(
        { error: data.error || '챗봇 요청 실패' },
        { status: response.status }
      );
    }
    return NextResponse.json(data);
  } catch (error: unknown) {
    console.error('[chat] Proxy error:', error);
    const message = error instanceof Error ? error.message : String(error);
    
    // 네트워크 오류인 경우 백엔드 서버 연결 실패로 판단
    if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
      return NextResponse.json(
        { error: '백엔드 서버에 연결할 수 없습니다. 서버가 실행 중인지 확인해주세요.' },
        { status: 503 }
      );
    }
    
    return NextResponse.json(
      { error: `챗봇 서버 연결 실패: ${message}` },
      { status: 500 }
    );
  }
}
