import { NextResponse } from 'next/server';

// 캐시 때문에 안 바뀌는 거 방지 (이거 한 줄이면 됨)
export const dynamic = 'force-dynamic';

export async function GET() {
  // 1. 그냥 여기에 키를 박아버립니다. (작동 최우선!)
  const clientId = 'F2ptOkZA5LgHGpJMA0Y0';
  const clientSecret = 'koyZArtnqn';

  const query = '엘앤에프';
  const display = '5';
  const sort = 'sim';
  const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(query)}&display=${display}&sort=${sort}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Naver-Client-Id': clientId,
        'X-Naver-Client-Secret': clientSecret,
      },
    });

    const data = await response.json();
    return NextResponse.json(data);

  } catch (error) {
    return NextResponse.json({ error: '에러 발생' }, { status: 500 });
  }
}
