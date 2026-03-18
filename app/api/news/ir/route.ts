import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** 엘앤에프 네이버 뉴스 검색 URL (최신 뉴스 확인용 단일 링크) */
const NAVER_NEWS_SEARCH_URL = 'https://search.naver.com/search.naver?where=news&query=엘앤에프';

export async function GET() {
  return NextResponse.json({
    success: true,
    items: [
      {
        title: '엘앤에프 관련 최신 뉴스 보기',
        url: NAVER_NEWS_SEARCH_URL,
        date: '',
        source: '네이버 뉴스',
      },
    ],
  });
}
