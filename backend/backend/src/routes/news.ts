import type { FastifyInstance } from 'fastify';

const NAVER_NEWS_API_URL = 'https://openapi.naver.com/v1/search/news.json';
const NEWS_KEYWORD = '엘앤에프';
const NEWS_DISPLAY = 5;

/** 네이버 뉴스 검색 API용 클라이언트 ID (나중에 채워 넣으세요) */
const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID ?? '';
/** 네이버 뉴스 검색 API용 클라이언트 시크릿 (나중에 채워 넣으세요) */
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET ?? '';

export type NaverNewsItem = {
  title: string;
  link: string;
  description: string;
  pubDate: string;
  originallink?: string;
};

async function fetchNaverNews(): Promise<NaverNewsItem[]> {
  if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) {
    return [];
  }
  const params = new URLSearchParams({
    query: NEWS_KEYWORD,
    display: String(NEWS_DISPLAY),
    sort: 'date',
  });
  const res = await fetch(`${NAVER_NEWS_API_URL}?${params.toString()}`, {
    headers: {
      'X-Naver-Client-Id': NAVER_CLIENT_ID,
      'X-Naver-Client-Secret': NAVER_CLIENT_SECRET,
    },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { items?: NaverNewsItem[] };
  return Array.isArray(data.items) ? data.items : [];
}

export async function registerNewsRoutes(app: FastifyInstance) {
  app.get('/api/news', async (_request, reply) => {
    try {
      const items = await fetchNaverNews();
      return reply.send({
        success: true,
        items: items.map((item) => ({
          title: item.title,
          link: item.link,
          description: item.description ?? '',
          pubDate: item.pubDate ?? '',
          originallink: item.originallink,
        })),
      });
    } catch (err) {
      app.log.error(err);
      return reply.code(500).send({
        success: false,
        items: [],
        error: err instanceof Error ? err.message : 'Failed to fetch news',
      });
    }
  });
}
