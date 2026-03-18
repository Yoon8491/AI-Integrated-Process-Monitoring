import { NextRequest, NextResponse } from 'next/server';
import { getBackendUrl } from '@/lib/backend-url';
import { sanitizeForJSON } from '@/lib/json-sanitizer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 불량 레포트 API 프록시 라우트
 * Vercel 배포 시 백엔드 서버로 요청을 프록시합니다.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const lotId = searchParams.get('lotId');
    
    if (!lotId) {
      return NextResponse.json(
        { success: false, error: 'lotId is required' },
        { status: 400 }
      );
    }

    // 백엔드 서버 URL (환경 변수 우선, 없으면 환경에 따라 분기)
    const backendUrl = getBackendUrl();

    // 인증 토큰 가져오기 (대소문자 구분 없이)
    // Next.js의 headers는 모든 헤더를 소문자로 정규화하므로 'authorization'으로 읽어야 함
    const authHeader = request.headers.get('authorization');
    
    // 디버깅: 모든 헤더 확인
    const allHeaders = Object.fromEntries(request.headers.entries());
    console.log('[lot-defect-report] GET request:', { 
      lotId, 
      backendUrl, 
      hasAuthHeader: !!authHeader,
      authHeaderPreview: authHeader ? `${authHeader.substring(0, 20)}...` : null,
      allHeaderKeys: Object.keys(allHeaders)
    });

    // 백엔드로 요청 전달
    const fetchUrl = `${backendUrl}/api/dashboard/lot-defect-report?lotId=${encodeURIComponent(lotId)}`;
    console.log('[lot-defect-report] GET fetch URL:', fetchUrl);
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    
    if (authHeader) {
      headers['Authorization'] = authHeader;
    }
    
    const response = await fetch(fetchUrl, {
      method: 'GET',
      headers,
    });
    
    console.log('[lot-defect-report] GET response status:', response.status);
    console.log('[lot-defect-report] GET response ok:', response.ok);
    
    let data;
    let responseText: string | null = null;
    try {
      responseText = await response.text();
      console.log('[lot-defect-report] GET response text (first 500 chars):', responseText.substring(0, 500));
      
      // Infinity/NaN이 포함된 JSON 문자열 처리
      // Infinity나 NaN을 문자열로 찾아서 null로 치환
      const sanitizedText = responseText
        .replace(/:\s*Infinity\b/g, ': null')
        .replace(/:\s*-Infinity\b/g, ': null')
        .replace(/:\s*NaN\b/g, ': null');
      
      data = sanitizedText ? JSON.parse(sanitizedText) : {};
      
      // 파싱 후에도 한 번 더 sanitize (중첩 객체 처리)
      data = sanitizeForJSON(data);
      
      console.log('[lot-defect-report] GET parsed data:', JSON.stringify(data).substring(0, 200));
    } catch (jsonError) {
      console.error('[lot-defect-report] GET JSON parse error:', jsonError);
      console.error('[lot-defect-report] GET response text (full):', responseText?.substring(0, 1000) || 'No text available');
      // response.text()는 이미 호출했으므로 다시 호출할 수 없음
      return NextResponse.json(
        { success: false, error: `서버 응답을 파싱할 수 없습니다: ${jsonError instanceof Error ? jsonError.message : String(jsonError)}` },
        { status: 500 }
      );
    }

    if (!response.ok) {
      return NextResponse.json(
        { success: false, error: data.error || '레포트 조회 실패' },
        { status: response.status }
      );
    }

    return NextResponse.json(data);
  } catch (error: unknown) {
    console.error('[lot-defect-report] GET Proxy error:', error);
    console.error('[lot-defect-report] GET Error stack:', error instanceof Error ? error.stack : 'No stack');
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('ECONNREFUSED') || message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
      return NextResponse.json(
        { success: false, error: '백엔드 서버에 연결할 수 없습니다. 서버가 실행 중인지 확인해주세요.' },
        { status: 503 }
      );
    }

    return NextResponse.json(
      { success: false, error: `레포트 조회 실패: ${message}` },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { lotId, lotData, language } = body;

    if (!lotId || !lotData) {
      return NextResponse.json(
        { success: false, error: 'lotId and lotData are required' },
        { status: 400 }
      );
    }

    // 백엔드 서버 URL (환경 변수 우선, 없으면 환경에 따라 분기)
    const backendUrl = getBackendUrl();

    // 인증 토큰 가져오기 (대소문자 구분 없이)
    // Next.js의 headers는 모든 헤더를 소문자로 정규화하므로 'authorization'으로 읽어야 함
    const authHeader = request.headers.get('authorization');
    
    // 디버깅: 모든 헤더 확인
    const allHeaders = Object.fromEntries(request.headers.entries());
    console.log('[lot-defect-report] POST request:', { 
      lotId, 
      backendUrl, 
      hasAuth: !!authHeader,
      authHeaderPreview: authHeader ? `${authHeader.substring(0, 20)}...` : null,
      allHeaderKeys: Object.keys(allHeaders)
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    
    if (authHeader) {
      headers['Authorization'] = authHeader;
    }

    // 백엔드로 요청 전달
    const response = await fetch(`${backendUrl}/api/dashboard/lot-defect-report`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        lotId,
        lotData,
        language: language || 'ko',
      }),
    });

    let data;
    let responseText: string | null = null;
    try {
      responseText = await response.text();
      
      // Infinity/NaN이 포함된 JSON 문자열 처리
      const sanitizedText = responseText
        .replace(/:\s*Infinity\b/g, ': null')
        .replace(/:\s*-Infinity\b/g, ': null')
        .replace(/:\s*NaN\b/g, ': null');
      
      data = sanitizedText ? JSON.parse(sanitizedText) : {};
      
      // 파싱 후에도 한 번 더 sanitize (중첩 객체 처리)
      data = sanitizeForJSON(data);
    } catch (jsonError) {
      console.error('[lot-defect-report] POST JSON parse error:', jsonError);
      console.error('[lot-defect-report] POST response text (first 1000 chars):', responseText?.substring(0, 1000) || 'No text available');
      return NextResponse.json(
        { success: false, error: `서버 응답을 파싱할 수 없습니다: ${jsonError instanceof Error ? jsonError.message : String(jsonError)}` },
        { status: 500 }
      );
    }

    if (!response.ok) {
      return NextResponse.json(
        { success: false, error: data.error || '레포트 생성 실패' },
        { status: response.status }
      );
    }

    return NextResponse.json(data);
  } catch (error: unknown) {
    console.error('[lot-defect-report] POST Proxy error:', error);
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
      return NextResponse.json(
        { success: false, error: '백엔드 서버에 연결할 수 없습니다. 서버가 실행 중인지 확인해주세요.' },
        { status: 503 }
      );
    }

    return NextResponse.json(
      { success: false, error: `레포트 생성 실패: ${message}` },
      { status: 500 }
    );
  }
}
