import type { FastifyInstance } from 'fastify';
import OpenAI from 'openai';
import { authQuery } from '../db.js';
import { requireAuth } from '../middlewares/auth.js';

type ChatHistoryMsg = { role: 'user' | 'bot'; text: string };

export async function registerChatRoutes(app: FastifyInstance) {
  app.post('/api/chat', async (request, reply) => {
    try {
      // 인증 확인
      const user = await requireAuth(request);
      if (!user) {
        return reply.code(401).send({ error: '인증이 필요합니다.' });
      }

      const body = request.body as any;
      const { 
        message, 
        conversationHistory = [], 
        notices = [], 
        communications = [],
        enableRAG: requestRAG = false,
        includeNotices = false,
        includeCommunications = false,
        dashboardContext = null,
        lotDefectReport = null,
        lotId: requestLotId = null,
        isRecentDefectLotQuery = false,
        stream: useStream = false,
      } = body;

      if (!message || typeof message !== 'string' || !message.trim()) {
        return reply.code(400).send({ error: '메시지를 입력해주세요.' });
      }

      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return reply.code(500).send({ error: 'OpenAI API 키가 설정되지 않았습니다.' });
      }

      // 사용자 정보 가져오기
      let userName = user.employeeNumber;
      let userRole = 'user';
      try {
        const userRows = await authQuery<Array<{ name: string; role: string }>>(
          'SELECT name, role FROM users WHERE employee_number = ?',
          [user.employeeNumber]
        );
        if (Array.isArray(userRows) && userRows.length > 0) {
          userName = userRows[0]?.name || user.employeeNumber;
          userRole = userRows[0]?.role || 'user';
        }
      } catch (dbError) {
        request.log.warn({ err: dbError }, 'Failed to fetch user info, using defaults');
        // DB 오류가 있어도 챗봇은 계속 작동하도록 함
      }

      // 컨텍스트 구성
      const contextParts: string[] = [];

      // RAG 기능은 현재 비활성화 (필요시 OpenAI embeddings로 구현 가능)
      if (requestRAG) {
        // TODO: OpenAI embeddings를 사용한 RAG 구현 가능
        console.warn('RAG 기능은 현재 OpenAI로 구현되지 않았습니다.');
      }

      // 공지사항과 커뮤니케이션은 사용자가 명시적으로 요청할 때만 포함
      if (includeNotices && notices.length > 0) {
        contextParts.push('\n=== 공지사항 ===');
        notices.forEach((notice: any) => {
          contextParts.push(`- ${notice.title}: ${notice.content}`);
        });
      }

      if (includeCommunications && communications.length > 0) {
        contextParts.push('\n=== 커뮤니케이션 ===');
        communications.forEach((comm: any) => {
          contextParts.push(`- ${comm.title}: ${comm.content}`);
        });
      }

      // 대시보드/공정 현황 데이터 (LOT별 공정 현황, 품질, 생산, 불량률 등)
      if (dashboardContext && typeof dashboardContext === 'object') {
        contextParts.push('\n=== 대시보드/공정 현황 데이터 (참고하여 질문에 답하세요) ===');
        try {
          const dc = dashboardContext as Record<string, unknown>;
          // 특정 날짜 생산량 질문 시: 대시보드 캘린더와 동일한 수치(requestedDateProduction)를 반드시 사용하세요.
          const reqDateProd = dc.requestedDateProduction as { year: number; month: number; day: number; production: number; defectRate: number; unitKo: string; unitEn: string } | undefined;
          if (reqDateProd && typeof reqDateProd === 'object' && reqDateProd.year != null && reqDateProd.day != null) {
            contextParts.push(
              `[특정 날짜 생산량 - 대시보드 캘린더와 동일한 공식 수치] ${reqDateProd.year}년 ${reqDateProd.month}월 ${reqDateProd.day}일: 생산량 ${reqDateProd.production} ${reqDateProd.unitKo || 'kg'}, 불량률 ${reqDateProd.defectRate}%. 이 날짜에 대한 생산량/불량률 질문에는 반드시 이 수치로 답하세요.`
            );
          }
          const summary = dc.summary as Record<string, unknown> | undefined;
          if (summary && typeof summary === 'object') {
            contextParts.push('[요약] ' + JSON.stringify(summary, null, 0).slice(0, 2000));
          }
          if (dc.quality && typeof dc.quality === 'object') {
            const q = dc.quality as Record<string, unknown>;
            if (q.success && (q.data || q.byLine)) contextParts.push('[품질] ' + JSON.stringify({ data: q.data, byLine: q.byLine }).slice(0, 1500));
          }
          if (dc.production && typeof dc.production === 'object') {
            const p = dc.production as Record<string, unknown>;
            if (p.success && (p.data || p.byLine)) contextParts.push('[생산] ' + JSON.stringify({ data: p.data, byLine: p.byLine }).slice(0, 1500));
          }
          if (dc.columnQuery && typeof dc.columnQuery === 'object') {
            const cq = dc.columnQuery as Record<string, unknown>;
            if (cq.matched && (cq.data || cq.stats)) contextParts.push('[컬럼 조회] ' + JSON.stringify({ columns: cq.columns, stats: cq.stats, dataSample: Array.isArray(cq.data) ? cq.data.slice(0, 5) : cq.data }).slice(0, 1500));
          }
          if (dc.period) contextParts.push(`[기간] ${String(dc.period)}`);
          if (dc.recentDefectLotMessage && typeof dc.recentDefectLotMessage === 'string') {
            contextParts.push('[최근 불량 LOT 안내 - 반드시 준수] ' + dc.recentDefectLotMessage);
          }
        } catch (e) {
          contextParts.push(JSON.stringify(dashboardContext).slice(0, 3000));
        }
      }

      // 특정 LOT 불량 레포트 (해당 LOT에 대한 질문 시 불량 원인·레포트 내용까지 답변 가능)
      if (lotDefectReport && typeof lotDefectReport === 'object') {
        contextParts.push('\n=== LOT 불량 레포트 (해당 LOT에 대한 질문에 반드시 이 내용을 바탕으로 답하세요) ===');
        try {
          const ldr = lotDefectReport as Record<string, unknown>;
          const reportText = ldr.report;
          if (reportText != null) {
            const text = typeof reportText === 'string' ? reportText : (reportText as any)?.report_content ?? String(reportText);
            contextParts.push('[레포트 전문]\n' + text.slice(0, 6000));
          }
          const vis = ldr.visualization;
          if (vis && typeof vis === 'object') {
            const v = vis as Record<string, unknown>;
            if (v.tables && Array.isArray(v.tables)) {
              v.tables.forEach((t: any, i: number) => {
                const title = t?.title ?? `표 ${i + 1}`;
                const rows = t?.rows ?? [];
                contextParts.push(`[표: ${title}] 행 ${rows.length}개. 데이터: ${JSON.stringify(rows.slice(0, 15)).slice(0, 800)}`);
              });
            }
            if (v.charts && Array.isArray(v.charts)) {
              v.charts.forEach((c: any, i: number) => {
                const title = c?.title ?? `차트 ${i + 1}`;
                const data = c?.data ?? [];
                contextParts.push(`[차트: ${title}] ${JSON.stringify(data).slice(0, 500)}`);
              });
            }
            if (v.statistics && typeof v.statistics === 'object') {
              contextParts.push('[통계] ' + JSON.stringify(v.statistics).slice(0, 1000));
            }
          }
          if (requestLotId) contextParts.push(`[LOT ID] ${requestLotId}`);
        } catch (e) {
          contextParts.push(JSON.stringify(lotDefectReport).slice(0, 4000));
        }
      }

      // 공정별 에너지(전력) 데이터 - 에너지 시각 분석 대시보드 "공정별 에너지 등급 및 효율 상세" 테이블
      const processEnergyTable = dashboardContext && typeof dashboardContext === 'object' ? (dashboardContext as Record<string, unknown>).processEnergyTable : undefined;
      if (Array.isArray(processEnergyTable) && processEnergyTable.length > 0) {
        contextParts.push('\n=== 공정별 전력 소모 (에너지 시각 분석 대시보드 기준, 이 수치로 답하세요) ===');
        const rows = processEnergyTable.map((p: any) =>
          `${p.processKo || p.processEn}(코팅/혼합 등): 등급 ${p.energyGrade || '-'}, 전력소모 ${p.powerConsumptionKwh ?? p.powerConsumption ?? '-'} KWH, 생산(현재/목표) ${p.productionCurrent ?? '-'}/${p.productionTarget ?? '-'}, 제품1개당 에너지 ${p.energyPerUnit ?? '-'} KWH/개, 탄소배출 ${p.carbonEmission ?? '-'} kgCO2e`
        );
        contextParts.push(rows.join('\n'));
      }

      const context = contextParts.length > 0 ? contextParts.join('\n\n') : '';

      // OpenAI API 호출
      const openai = new OpenAI({ apiKey });
      const modelName = process.env.OPENAI_MODEL_NAME || 'gpt-4o-mini';

      const hasChartData = lotDefectReport && typeof lotDefectReport === 'object' &&
        (lotDefectReport as any)?.visualization?.charts?.length > 0;

      const baseRules = `답변 규칙 (반드시 지킬 것):
- 핵심만 간결하게, 불필요한 서론·수식어 없이 답하세요.
- 여러 항목을 나열할 때는 반드시 항목마다 줄바꿈을 넣어 한 줄에 한 항목만 오도록 하세요. (예: 제목 다음에 줄바꿈, 그 다음 • 항목1 줄바꿈 • 항목2 줄바꿈)
- 불릿(•)이나 짧은 문단으로 정리하고, 한 문장은 짧게 유지하세요.
- 수치·날짜·LOT ID 등은 정확히 인용하되, 설명은 요약만 하세요.
- 2~4문장 또는 3~5개 불릿 이내로 끝내고, 필요할 때만 한두 줄 보충하세요.
- 같은 데이터를 두 번 이상 반복하지 마세요. 한 번만 언급하면 충분합니다.${hasChartData ? `
- 차트/그래프 데이터는 시스템이 자동으로 시각적 막대 차트로 렌더링합니다. 따라서 파라미터별 수치를 텍스트로 나열하지 마세요. 대신 핵심 인사이트(가장 영향도가 높은 파라미터, 주의사항 등)만 간단히 설명하세요.` : ''}`;

      const systemInstruction = context
        ? `당신은 제조업 공정 관리 시스템의 챗봇입니다.

${baseRules}

아래 [참고 정보]는 대시보드·공정 현황·LOT 불량 레포트 등 실제 데이터입니다. 이 데이터만 사용해 질문에 답하고, 없는 내용은 추측하지 마세요.

[참고 정보]
${context}`
        : `당신은 제조업 공정 관리 시스템의 챗봇입니다.

${baseRules}`;

      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: 'system', content: systemInstruction }
      ];

      // 대화 히스토리 추가 (최근 10개)
      conversationHistory.forEach((msg: ChatHistoryMsg) => {
        if (msg.role === 'user') {
          messages.push({ role: 'user', content: msg.text });
        } else if (msg.role === 'bot') {
          messages.push({ role: 'assistant', content: msg.text });
        }
      });

      // 현재 사용자 메시지 추가
      messages.push({
        role: 'user',
        content: `사용자 (${userName}, ${userRole === 'admin' ? '관리자' : '일반 사용자'}): ${message}`
      });

      const totalMessageLength = messages.reduce((sum, msg) => sum + (typeof msg.content === 'string' ? msg.content.length : 0), 0);
      console.log('[chat API] ⚠️ OpenAI API 호출 시작 - 토큰 사용됨!', {
        userName,
        messageLength: message.length,
        historyCount: conversationHistory.length,
        totalMessages: messages.length,
        stream: useStream,
        estimatedTokens: Math.ceil(totalMessageLength / 4)
      });

      if (useStream) {
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        let fullContent = '';
        try {
          const stream = await openai.chat.completions.create({
            model: modelName,
            messages,
            temperature: 0.7,
            stream: true,
          });
          for await (const chunk of stream) {
            const piece = chunk.choices[0]?.delta?.content;
            if (piece) {
              fullContent += piece;
              reply.raw.write('data: ' + JSON.stringify({ content: piece }) + '\n\n');
            }
          }
          // LOT 파라미터별 차트 요청 시 visualization에서 막대 차트 데이터 전송 (챗봇에서 차트 렌더링)
          const wantChart = /차트|파라미터별|보여줘|그래프|chart/i.test(message) && lotDefectReport && typeof lotDefectReport === 'object';
          const vis = (lotDefectReport as any)?.visualization;
          const charts = Array.isArray(vis?.charts) ? vis.charts : [];
          const barChart = charts.find((c: any) => c.type === 'bar' && Array.isArray(c.data) && c.data.length > 0);
          if (wantChart && barChart) {
            reply.raw.write('data: ' + JSON.stringify({ chart: { title: barChart.title || '파라미터별 불량 영향도 (%)', data: barChart.data } }) + '\n\n');
          }
          reply.raw.write('data: ' + JSON.stringify({ done: true }) + '\n\n');
        } catch (streamErr: any) {
          const errMsg = streamErr?.message || String(streamErr);
          reply.raw.write('data: ' + JSON.stringify({ error: errMsg }) + '\n\n');
        }
        reply.raw.end();
        return;
      }

      const completion = await openai.chat.completions.create({
        model: modelName,
        messages: messages,
        temperature: 0.7,
      });
      
      console.log('[chat API] ✅ OpenAI API 호출 완료', {
        userName,
        responseLength: completion.choices[0]?.message?.content?.length || 0,
        usage: completion.usage ? {
          promptTokens: completion.usage.prompt_tokens,
          completionTokens: completion.usage.completion_tokens,
          totalTokens: completion.usage.total_tokens
        } : 'N/A'
      });

      const botMessage = completion.choices[0]?.message?.content;
      
      if (!botMessage) {
        request.log.warn('OpenAI returned empty message', { completion });
        return reply.code(500).send({
          success: false,
          error: '챗봇 응답을 생성할 수 없습니다. 다시 시도해주세요.',
        });
      }

      return reply.send({
        success: true,
        message: botMessage,
      });
    } catch (error: any) {
      console.error('챗봇 오류:', error);
      const errorDetails = {
        message: error?.message,
        stack: error?.stack,
        response: error?.response?.data,
        status: error?.response?.status,
        code: error?.code,
        name: error?.name,
      };
      request.log.error({ err: error, errorDetails }, 'Chat API error');
      
      let errorMessage = '챗봇 응답 중 오류가 발생했습니다.';
      const msg = String(error?.message || error || '');

      if (msg.includes('API_KEY_INVALID') || msg.includes('API key') || msg.includes('Invalid API key')) {
        errorMessage = 'OpenAI API 키가 유효하지 않습니다. 환경 변수를 확인해주세요.';
      } else if (msg.includes('quota') || msg.includes('쿼터') || msg.includes('한도') || msg.includes('429') || msg.includes('rate_limit')) {
        errorMessage = 'API 요청 한도를 초과했습니다. 잠시 후 다시 시도해주세요.';
      } else if (msg.includes('network') || msg.includes('fetch') || msg.includes('ECONNREFUSED')) {
        errorMessage = '네트워크 오류가 발생했습니다. 잠시 후 다시 시도해주세요.';
      } else if (process.env.NODE_ENV === 'development') {
        errorMessage = `개발 모드 오류: ${msg}`;
      }

      return reply.code(500).send({
        success: false,
        error: errorMessage,
      });
    }
  });
}
