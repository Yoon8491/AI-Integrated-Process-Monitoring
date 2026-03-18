'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import Sidebar from '@/components/Sidebar';
import Navbar from '@/components/Navbar';
import Card from '@/components/Card';
import { useLanguage } from '@/contexts/LanguageContext';
import { useRightSidebar } from '@/contexts/RightSidebarContext';
import { authHeader, dashboardApiUrl } from '@/lib/api-client';

/** 구간별 불량률 API/데모용 타입 */
type IntervalBin = { label: string; min: number; max: number; defectRate: number; count: number };
type IntervalSeries = { paramName: string; bins: IntervalBin[]; averageDefectRate: number };

const INTERVAL_STORAGE_KEY = 'dashboard-defect-intervals';

function getCachedIntervalData(): IntervalSeries[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = sessionStorage.getItem(INTERVAL_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as IntervalSeries[]) : [];
  } catch {
    return [];
  }
}

/** API와 동일: 건수 = 해당 구간에 속하는 공정 데이터 행(샘플) 수. 데모는 변수당 1000건을 5구간 균등 분할. */
const DEMO_INTERVAL_DATA: IntervalSeries[] = [
  {
    paramName: 'metal_impurity',
    averageDefectRate: 0.082,
    bins: [
      { label: '0.0080 - 0.0140', min: 0.008, max: 0.014, defectRate: 0.072, count: 200 },
      { label: '0.0140 - 0.0200', min: 0.014, max: 0.02, defectRate: 0.065, count: 200 },
      { label: '0.0200 - 0.0260', min: 0.02, max: 0.026, defectRate: 0.088, count: 200 },
      { label: '0.0260 - 0.0320', min: 0.026, max: 0.032, defectRate: 0.091, count: 200 },
      { label: '0.0320 - 0.0450', min: 0.032, max: 0.045, defectRate: 0.112, count: 200 },
    ],
  },
  {
    paramName: 'humidity',
    averageDefectRate: 0.078,
    bins: [
      { label: '32.0 - 42.0', min: 32, max: 42, defectRate: 0.055, count: 200 },
      { label: '42.0 - 52.0', min: 42, max: 52, defectRate: 0.068, count: 200 },
      { label: '52.0 - 62.0', min: 52, max: 62, defectRate: 0.082, count: 200 },
      { label: '62.0 - 72.0', min: 62, max: 72, defectRate: 0.095, count: 200 },
      { label: '72.0 - 85.0', min: 72, max: 85, defectRate: 0.108, count: 200 },
    ],
  },
  {
    paramName: 'lithium_input',
    averageDefectRate: 0.081,
    bins: [
      { label: '0.94 - 0.98', min: 0.94, max: 0.98, defectRate: 0.098, count: 200 },
      { label: '0.98 - 1.02', min: 0.98, max: 1.02, defectRate: 0.058, count: 200 },
      { label: '1.02 - 1.06', min: 1.02, max: 1.06, defectRate: 0.067, count: 200 },
      { label: '1.06 - 1.10', min: 1.06, max: 1.1, defectRate: 0.089, count: 200 },
      { label: '1.10 - 1.15', min: 1.1, max: 1.15, defectRate: 0.112, count: 200 },
    ],
  },
  {
    paramName: 'process_time',
    averageDefectRate: 0.079,
    bins: [
      { label: '48 - 54', min: 48, max: 54, defectRate: 0.062, count: 200 },
      { label: '54 - 60', min: 54, max: 60, defectRate: 0.071, count: 200 },
      { label: '60 - 66', min: 60, max: 66, defectRate: 0.085, count: 200 },
      { label: '66 - 72', min: 66, max: 72, defectRate: 0.094, count: 200 },
      { label: '72 - 84', min: 72, max: 84, defectRate: 0.105, count: 200 },
    ],
  },
  {
    paramName: 'temperature',
    averageDefectRate: 0.083,
    bins: [
      { label: '750 - 780', min: 750, max: 780, defectRate: 0.068, count: 200 },
      { label: '780 - 810', min: 780, max: 810, defectRate: 0.077, count: 200 },
      { label: '810 - 840', min: 810, max: 840, defectRate: 0.089, count: 200 },
      { label: '840 - 870', min: 840, max: 870, defectRate: 0.092, count: 200 },
      { label: '870 - 900', min: 870, max: 900, defectRate: 0.109, count: 200 },
    ],
  },
  {
    paramName: 'tank_pressure',
    averageDefectRate: 0.078,
    bins: [
      { label: '95 - 100', min: 95, max: 100, defectRate: 0.065, count: 200 },
      { label: '100 - 105', min: 100, max: 105, defectRate: 0.072, count: 200 },
      { label: '105 - 110', min: 105, max: 110, defectRate: 0.081, count: 200 },
      { label: '110 - 115', min: 110, max: 115, defectRate: 0.088, count: 200 },
      { label: '115 - 125', min: 115, max: 125, defectRate: 0.096, count: 200 },
    ],
  },
  {
    paramName: 'sintering_temp',
    averageDefectRate: 0.085,
    bins: [
      { label: '700 - 768', min: 700, max: 768, defectRate: 0.107, count: 200 },
      { label: '768 - 789', min: 768, max: 789, defectRate: 0.07, count: 200 },
      { label: '789 - 810', min: 789, max: 810, defectRate: 0.087, count: 200 },
      { label: '810 - 831', min: 810, max: 831, defectRate: 0.072, count: 200 },
      { label: '831 - 900', min: 831, max: 900, defectRate: 0.091, count: 200 },
    ],
  },
  {
    paramName: 'additive_ratio',
    averageDefectRate: 0.08,
    bins: [
      { label: '0.12 - 0.14', min: 0.12, max: 0.14, defectRate: 0.075, count: 200 },
      { label: '0.14 - 0.16', min: 0.14, max: 0.16, defectRate: 0.082, count: 200 },
      { label: '0.16 - 0.18', min: 0.16, max: 0.18, defectRate: 0.079, count: 200 },
      { label: '0.18 - 0.20', min: 0.18, max: 0.2, defectRate: 0.086, count: 200 },
      { label: '0.20 - 0.22', min: 0.2, max: 0.22, defectRate: 0.098, count: 200 },
    ],
  },
  {
    paramName: 'd50',
    averageDefectRate: 0.085,
    bins: [
      { label: '3.50 - 3.89', min: 3.5, max: 3.89, defectRate: 0.175, count: 200 },
      { label: '3.89 - 4.29', min: 3.89, max: 4.29, defectRate: 0.03, count: 200 },
      { label: '4.29 - 4.68', min: 4.29, max: 4.68, defectRate: 0.035, count: 200 },
      { label: '4.68 - 5.09', min: 4.68, max: 5.09, defectRate: 0.037, count: 200 },
      { label: '5.09 - 5.50', min: 5.09, max: 5.5, defectRate: 0.148, count: 200 },
    ],
  },
];

function formatBinShortLabel(bin: IntervalBin): string {
  const { label, min, max } = bin;
  if (label === '미측정' || min == null || max == null || (Number.isNaN(min) && Number.isNaN(max))) return label;
  const magnitude = Math.max(Math.abs(min), Math.abs(max), 0.001);
  const decimals = magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : magnitude >= 1 ? 2 : magnitude >= 0.1 ? 2 : 3;
  const a = Number(min.toFixed(decimals));
  const b = Number(max.toFixed(decimals));
  return `${a}~${b}`;
}

/** 구간별 불량률 막대 차트 1개 */
function DefectRateIntervalChart({
  series,
  language,
}: {
  series: IntervalSeries;
  language: string;
}) {
  const [hoveredBin, setHoveredBin] = useState<number | null>(null);
  const { paramName, bins } = series;
  if (bins.length === 0) {
    return (
      <p className="text-slate-500 text-sm py-6 text-center">
        {language === 'ko' ? '구간 데이터가 없습니다.' : 'No interval data.'}
      </p>
    );
  }
  const maxRate = Math.max(...bins.map((b) => b.defectRate), 0.01);
  const yMax = Math.ceil(maxRate * 20) / 20 || 0.1;
  const yTicks = [0, yMax * 0.25, yMax * 0.5, yMax * 0.75, yMax].map((v) => Number(v.toFixed(3)));

  const countHint = language === 'ko'
    ? '건수: 해당 구간에 속하는 공정 데이터 행(샘플) 수'
    : 'Count: number of process data rows (samples) in this bin';

  return (
    <div className="flex flex-col h-full min-h-[260px] relative">
      <h3 className="text-sm font-semibold text-slate-800 mb-1">
        [{paramName}] {language === 'ko' ? '구간별 불량률' : 'Defect Rate by Section'}
      </h3>
      <p className="text-[10px] text-slate-500 mb-2" title={countHint}>
        {language === 'ko' ? '건수 = 구간별 샘플(행) 수' : 'Count = samples per bin'}
      </p>
      <div className="flex-1 flex gap-2 min-h-0">
        <div className="w-14 flex-shrink-0 flex flex-col text-xs text-slate-500 py-1 pr-1">
          <span className="flex-shrink-0 h-5 flex items-center">{language === 'ko' ? '불량률' : 'Defect Rate'}</span>
          <div className="flex-1 flex flex-col justify-between min-h-0">
            {[...yTicks].reverse().map((t) => (
              <span key={t}>{(t * 100).toFixed(1)}%</span>
            ))}
          </div>
        </div>
        <div
          className="flex-1 flex flex-col relative border-l border-b border-slate-200 min-h-0"
          style={{ minHeight: '200px' }}
          onMouseLeave={() => setHoveredBin(null)}
        >
          {hoveredBin != null && bins[hoveredBin] && (
            <div
              className="absolute z-20 px-2 py-1.5 rounded bg-slate-800 text-white text-xs whitespace-nowrap shadow-lg pointer-events-none"
              style={{ left: '50%', top: '8px', transform: 'translateX(-50%)' }}
            >
              <div className="font-medium">{bins[hoveredBin].label}</div>
              <div>
                {language === 'ko' ? '불량률' : 'Defect rate'}: <strong>{(bins[hoveredBin].defectRate * 100).toFixed(2)}%</strong>
                {bins[hoveredBin].count != null && (
                  <> · <span title={countHint}>{language === 'ko' ? '건수' : 'Count'}: {bins[hoveredBin].count}</span></>
                )}
              </div>
            </div>
          )}
          <div className="absolute top-5 left-0 right-0 bottom-0">
            <div className="absolute inset-0 flex items-end justify-around gap-0.5 px-1">
              {bins.map((bin, i) => {
                const pct = (bin.defectRate / yMax) * 100;
                const intensity = Math.min(1, bin.defectRate / yMax);
                const color = intensity < 0.33 ? '#fdba74' : intensity < 0.66 ? '#ea580c' : '#b91c1c';
                const isHovered = hoveredBin === i;
                return (
                  <div
                    key={i}
                    className="flex-1 flex flex-col items-center justify-end min-w-0"
                    style={{ height: '100%' }}
                    onMouseEnter={() => setHoveredBin(i)}
                  >
                    <div
                      className="w-full rounded-t transition-all"
                      style={{
                        height: `${Math.min(100, pct)}%`,
                        minHeight: bin.defectRate > 0 ? '4px' : 0,
                        backgroundColor: color,
                        outline: isHovered ? '2px solid #475569' : undefined,
                        outlineOffset: isHovered ? '1px' : undefined,
                        transformOrigin: 'bottom',
                        transform: 'scaleY(0)',
                        animation: 'defect-bar-grow 0.9s ease-out forwards',
                      } as React.CSSProperties}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <div className="flex gap-2 mt-1 min-w-0">
        <div className="w-14 flex-shrink-0" aria-hidden />
        <div className="flex-1 flex justify-around gap-0.5 px-1 pt-2 border-t border-slate-100 min-w-0">
          {bins.map((bin, i) => (
            <div
              key={i}
              className={`flex-1 text-[10px] text-center min-w-0 max-w-[80px] break-words leading-tight transition-colors ${
                hoveredBin === i ? 'text-slate-900 font-semibold' : 'text-slate-600'
              }`}
              title={bin.label}
              onMouseEnter={() => setHoveredBin(i)}
              onMouseLeave={() => setHoveredBin(null)}
            >
              {formatBinShortLabel(bin)}
            </div>
          ))}
        </div>
      </div>
      <p className="text-[10px] text-slate-400 mt-0.5 px-1">
        {language === 'ko' ? '값 구간 (호버 시 상세)' : 'Value range (hover for full)'}
      </p>
    </div>
  );
}

type AnalyticsData = {
  importance: { name: string; importance: number }[];
  defectLots?: { lot: string; defectRate: number; variables: Record<string, number> }[];
  defectTrend?: { time: string; defectRate: number; passRate: number }[];
  targetColumn?: string;
  error?: string;
};

export default function AnalyticsPage() {
  const { alertsPanelOpen, alertsSidebarWidth, rightSidebarOpen, rightSidebarWidth } = useRightSidebar();
  const { t, language } = useLanguage();
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [defectTrendTooltip, setDefectTrendTooltip] = useState<{
    time: string;
    defectRate: number;
    xPct: number;
    yPct: number;
    index: number;
  } | null>(null);
  const [pinnedDefectTrendIndex, setPinnedDefectTrendIndex] = useState<number | null>(null);
  /** 호버 시 세로 점선 + 해당 점 표시 (센서 차트와 동일) */
  const [defectTrendHover, setDefectTrendHover] = useState<{
    index: number;
    time: string;
    defectRate: number;
    x: number;
    y: number;
    mouseX: number;
  } | null>(null);
  const defectTrendSvgRef = useRef<SVGSVGElement>(null);
  /** 캘린더(공정 현황)와 동일한 일별 전체 불량률. dateKey -> defectRate */
  const [calendarRatesByDate, setCalendarRatesByDate] = useState<Record<string, number>>({});
  /** 구간별 불량률 (API 또는 세션 캐시·데모) */
  const [intervalData, setIntervalData] = useState<IntervalSeries[]>(getCachedIntervalData);

  // 새로고침/재진입 시 sessionStorage 캐시 복원(데모 대신 설정한 데이터 표시)
  useEffect(() => {
    const cached = getCachedIntervalData();
    if (cached.length > 0) setIntervalData((prev) => (prev.length > 0 ? prev : cached));
  }, []);

  useEffect(() => {
    fetch(dashboardApiUrl('/api/dashboard/analytics'), { headers: authHeader() })
      .then((res) => res.json())
      .then((json) => {
        if (json?.success) {
          setData(json);
          if (json.defectTrend?.length > 0) {
            const dateKeys = [...new Set(json.defectTrend.map((d: { time: string }) => d.time.slice(0, 10)))];
            const yearMonths = [...new Set(dateKeys.map((d: string) => d.slice(0, 7)))];
            const pad = (n: number) => String(n).padStart(2, '0');
            const map: Record<string, number> = {};
            Promise.all(
              yearMonths.map((ym) => {
                const [y, m] = ym.split('-').map(Number);
                return fetch(dashboardApiUrl(`/api/dashboard/calendar-month?year=${y}&month=${m}`), { headers: authHeader() })
                  .then((r) => r.json())
                  .then((cal: { success?: boolean; days?: { day: number; defectRate?: number }[] }) => {
                    if (cal?.success && Array.isArray(cal.days)) {
                      cal.days.forEach((row) => {
                        const dateKey = `${y}-${pad(m)}-${pad(row.day)}`;
                        if (row.defectRate != null) map[dateKey] = Number(row.defectRate);
                      });
                    }
                  });
              })
            ).then(() => setCalendarRatesByDate({ ...map }));
          }
        } else setError(json?.error || 'Failed to load');
      })
      .catch((err) => setError(String(err?.message || err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetch(dashboardApiUrl('/api/dashboard/defect-by-intervals?bins=5'), { headers: authHeader(), cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (json?.success && Array.isArray(json.intervals) && json.intervals.length > 0) {
          const next = json.intervals;
          setIntervalData(next);
          try {
            sessionStorage.setItem(INTERVAL_STORAGE_KEY, JSON.stringify(next));
          } catch {}
        }
        // 실패 또는 intervals 빈 배열이면 기존 intervalData 유지(캐시/이전 데이터 덮어쓰지 않음)
      })
      .catch(() => { /* 실패 시 상태 유지 */ });
  }, []);

  const X_AXIS_END_DATE = '2026-02-21';

  // 키보드 좌우 화살표 (차트와 동일: 2/22 이전 + 불량률 100% 제외)
  useEffect(() => {
    if (pinnedDefectTrendIndex === null || !data?.defectTrend || data.defectTrend.length === 0) return;

    const getKey = (t: string | Date) => typeof t === 'string' ? t.slice(0, 10) : (t instanceof Date ? t.toISOString().slice(0, 10) : '');
    const trendRaw = data.defectTrend.map((d) => ({ time: getKey(d.time) || String(d.time).slice(0, 10), defectRate: d.defectRate })).filter((d) => d.time.length >= 10);
    const filteredByEndDate = trendRaw.filter((d) => d.time <= '2026-02-22');
    const baseTrend = filteredByEndDate.length > 0 ? filteredByEndDate : trendRaw;
    const DEFECT_RATE_MAX = 16.3;
    const trendFiltered = baseTrend.filter((d) => d.defectRate <= DEFECT_RATE_MAX);
    const trend = trendFiltered.length > 0 ? trendFiltered : baseTrend;
    if (trend.length === 0) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        let newIndex = pinnedDefectTrendIndex;
        if (e.key === 'ArrowLeft') {
          newIndex = Math.max(0, pinnedDefectTrendIndex - 1);
        } else {
          newIndex = Math.min(trend.length - 1, pinnedDefectTrendIndex + 1);
        }
        if (newIndex !== pinnedDefectTrendIndex && trend[newIndex]) {
          setPinnedDefectTrendIndex(newIndex);
          const d = trend[newIndex];
          const len = trend.length;
          const x = 60 + (newIndex / Math.max(1, len - 1)) * 890;
          const rates = trend.map((r) => r.defectRate);
          const dataMax = Math.max(...rates);
          const yMax = dataMax <= 0 ? 10 : Math.max(10, Math.ceil((dataMax * 1.2 + 5) / 5) * 5);
          const yDomain = yMax || 1;
          const y = 250 - (d.defectRate / yDomain) * 200;
          setDefectTrendTooltip({ time: d.time, defectRate: d.defectRate, xPct: (x / 1000) * 100, yPct: (y / 300) * 100, index: newIndex });
        }
      } else if (e.key === 'Escape') {
        setPinnedDefectTrendIndex(null);
        setDefectTrendTooltip(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pinnedDefectTrendIndex, data?.defectTrend]);

  return (
    <div className="min-h-screen bg-slate-100">
      <Sidebar />
      <Navbar />

      <main 
        className="ml-64 mt-16 bg-slate-100 min-h-[calc(100vh-4rem)] p-6 overflow-x-hidden transition-all duration-200"
        style={{
          marginRight: alertsPanelOpen ? `${alertsSidebarWidth}px` : (rightSidebarOpen ? `${rightSidebarWidth}px` : '0px'),
        }}
      >
        <div className="max-w-full mx-auto">
          <div className="mb-6">
            <h2 className="text-2xl font-bold text-slate-900">{t('analytics.defectAnalysis')}</h2>
            <p className="text-slate-600 mt-1">{t('analytics.defectSubtitle')}</p>
          </div>

          {loading && (
            <div className="flex items-center justify-center py-12 text-slate-500">
              {t('analytics.noData').replace('표시할 데이터가 없습니다.', '로딩 중...')}
            </div>
          )}
          {error && (
            <div className="p-4 rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm">
              {error}
            </div>
          )}
          {!loading && data && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card
                title={
                  language === 'ko'
                    ? `불량 영향 변수 Top 6`
                    : `Defect Impact Variables (Top 6)`
                }
                className="lg:col-span-2"
              >
                {data.importance.length === 0 ? (
                  <p className="text-slate-500 text-sm py-4">{t('analytics.noData')}</p>
                ) : (
                  <>
                    <p className="text-sm text-slate-600 mb-4">
                      {t('analytics.defectFactorsDesc')}
                      {data.targetColumn && (
                        <span className="font-mono text-xs ml-2 px-2 py-1 bg-slate-100 rounded" title={language === 'ko' ? '상관계수 기준(불량·판정 컬럼). 이 컬럼은 목록에서 제외됨.' : 'Correlation target (defect/outcome column). Excluded from list.'}>
                          {t('analytics.target')}: {data.targetColumn}
                        </span>
                      )}
                    </p>
                    {(() => {
                      const top6 = data.importance.slice(0, 6);
                      const maxImp = Math.max(...top6.map((i) => i.importance), 0.0001);
                      return (
                    <div className="flex gap-8">
                      <div className="flex-1 space-y-3 max-w-xs">
                        {top6.slice(0, 3).map((item, idx) => (
                          <div key={item.name} className="flex items-center gap-3">
                            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-sm font-bold text-indigo-700">
                              {idx + 1}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex justify-between items-start gap-2 text-sm mb-1">
                                <span className="font-medium text-slate-800 break-words min-w-0" title={item.name}>
                                  {item.name.replace(/_/g, '_\u200B')}
                                </span>
                                <span className="text-slate-600 flex-shrink-0">{(item.importance * 100).toFixed(2)}%</span>
                              </div>
                              <div className="w-full bg-slate-200 rounded-full h-2">
                                <div
                                  className="bg-indigo-500 h-2 rounded-full transition-all"
                                  style={{
                                    width: `${Math.min(100, (item.importance / maxImp) * 100)}%`,
                                    transformOrigin: 'left',
                                    transform: 'scaleX(0)',
                                    animation: 'defect-bar-grow-x 0.9s ease-out forwards',
                                  } as React.CSSProperties}
                                />
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="flex-1 space-y-3 max-w-xs">
                        {top6.slice(3, 6).map((item, idx) => (
                          <div key={item.name} className="flex items-center gap-3">
                            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-sm font-bold text-indigo-700">
                              {idx + 4}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex justify-between items-start gap-2 text-sm mb-1">
                                <span className="font-medium text-slate-800 break-words min-w-0" title={item.name}>
                                  {item.name.replace(/_/g, '_\u200B')}
                                </span>
                                <span className="text-slate-600 flex-shrink-0">{(item.importance * 100).toFixed(2)}%</span>
                              </div>
                              <div className="w-full bg-slate-200 rounded-full h-2">
                                <div
                                  className="bg-indigo-500 h-2 rounded-full transition-all"
                                  style={{
                                    width: `${Math.min(100, (item.importance / maxImp) * 100)}%`,
                                    transformOrigin: 'left',
                                    transform: 'scaleX(0)',
                                    animation: 'defect-bar-grow-x 0.9s ease-out forwards',
                                  } as React.CSSProperties}
                                />
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                      );
                    })()}
                  </>
                )}
              </Card>

              {/* 주요 변수 구간별 불량률: API/캐시 데이터 우선, 없을 때만 데모 */}
              <Card
                title={
                  (intervalData.length > 0 ? intervalData : getCachedIntervalData()).length > 0
                    ? (language === 'ko' ? '주요 변수 구간별 불량률 분석' : 'Defect Rate by Interval (Key Variables)')
                    : (language === 'ko' ? '주요 변수 구간별 불량률 분석 (데모)' : 'Defect Rate by Interval (Demo)')
                }
                className="lg:col-span-2"
              >
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                  {(() => {
                    const displayIntervals = intervalData.length > 0 ? intervalData : getCachedIntervalData();
                    const base = displayIntervals.length > 0 ? displayIntervals : DEMO_INTERVAL_DATA;
                    const hasHumidity = base.some((s) => s.paramName.toLowerCase() === 'humidity');
                    const hasLithium = base.some((s) => s.paramName.toLowerCase() === 'lithium_input');
                    const humidityDemo = DEMO_INTERVAL_DATA.find((s) => s.paramName === 'humidity');
                    const lithiumDemo = DEMO_INTERVAL_DATA.find((s) => s.paramName === 'lithium_input');
                    const merged = [...base];
                    if (!hasHumidity && humidityDemo) merged.push(humidityDemo);
                    if (!hasLithium && lithiumDemo) merged.push(lithiumDemo);
                    // d50, metal_impurity는 맨 뒤로
                    const isLast = (p: string) => p.toLowerCase() === 'd50' || p.toLowerCase() === 'metal_impurity';
                    return merged.sort((a, b) => {
                      const aLast = isLast(a.paramName);
                      const bLast = isLast(b.paramName);
                      if (aLast && !bLast) return 1;
                      if (!aLast && bLast) return -1;
                      return 0;
                    });
                  })().map((series) => (
                    <div key={series.paramName} className="bg-white rounded-lg p-4 border border-slate-200">
                      <DefectRateIntervalChart series={series} language={language} />
                    </div>
                  ))}
                </div>
                {(intervalData.length > 0 ? intervalData : getCachedIntervalData()).length === 0 && (
                  <p className="text-slate-500 text-xs mt-3">
                    {language === 'ko'
                      ? '※ 공정 DB에 불량률·수치 컬럼이 연결되면 실제 데이터로 차트가 표시됩니다.'
                      : '※ Charts will show real data when process DB (defect rate + numeric columns) is connected.'}
                  </p>
                )}
              </Card>

              {data.defectTrend && data.defectTrend.length > 0 && (() => {
                const getDateKey = (t: string | Date): string => {
                  if (typeof t === 'string') return t.slice(0, 10);
                  if (t instanceof Date && !Number.isNaN(t.getTime())) return t.toISOString().slice(0, 10);
                  return '';
                };
                const toMonthDayKo = (dateKey: string): string => {
                  if (!dateKey) return '';
                  const isoMatch = dateKey.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
                  if (isoMatch) {
                    const m = parseInt(isoMatch[2], 10);
                    const d = parseInt(isoMatch[3], 10);
                    if (Number.isNaN(m) || Number.isNaN(d)) return '';
                    return `${m}월 ${d}일`;
                  }
                  const d = new Date(dateKey + (dateKey.length === 10 && dateKey[4] === '-' ? 'T12:00:00' : ''));
                  if (Number.isNaN(d.getTime())) return '';
                  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
                };
                const X_AXIS_END_DATE = '2026-02-22';
                const trendRaw = data.defectTrend.map((d) => {
                  const key = getDateKey(d.time);
                  return { time: key || String(d.time).slice(0, 10), defectRate: Number(d.defectRate), fromApi: true };
                }).filter((d) => d.time.length >= 10);
                const filteredByEndDate = trendRaw.filter((d) => d.time <= X_AXIS_END_DATE);
                const trendForChart = filteredByEndDate.length > 0 ? filteredByEndDate : trendRaw;
                const DEFECT_RATE_MAX = 16.3;
                const trendFiltered = trendForChart.filter((d) => d.defectRate <= DEFECT_RATE_MAX);
                const trend = trendFiltered.length > 0 ? trendFiltered : trendForChart;
                if (trend.length === 0) return null;
                const rates = trend.map((d) => d.defectRate);
                const dataMin = Math.min(...rates);
                const dataMax = Math.max(...rates);
                const yMin = 0;
                const yMaxPadded = dataMax <= 0 ? 10 : Math.max(10, Math.ceil((dataMax * 1.2 + 5) / 5) * 5);
                const yMax = yMaxPadded;
                const yDomain = yMax - yMin || 1;
                const toY = (v: number) => 250 - ((v - yMin) / yDomain) * 200;
                const yTicks = [yMin, yMin + yDomain * 0.25, yMin + yDomain * 0.5, yMin + yDomain * 0.75, yMax];
                const len = trend.length;
                const dateBoundaryIndices: number[] = [];
                for (let i = 7; i < trend.length; i += 7) dateBoundaryIndices.push(i);
                const avgDisplay = rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
                const CHART_LEFT = 60;
                const CHART_RIGHT = 950;
                const CHART_TOP = 50;
                const CHART_BOTTOM = 250;
                const chartW = CHART_RIGHT - CHART_LEFT;
                const indexToX = (i: number) => CHART_LEFT + (i / Math.max(1, len - 1)) * chartW;

                const handleDefectTrendMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
                  const svg = defectTrendSvgRef.current;
                  if (!svg || len === 0) return;
                  let svgX: number;
                  let svgY: number;
                  const ctm = svg.getScreenCTM();
                  if (ctm) {
                    const pt = svg.createSVGPoint();
                    pt.x = e.clientX;
                    pt.y = e.clientY;
                    const svgPt = pt.matrixTransform(ctm.inverse());
                    svgX = svgPt.x;
                    svgY = svgPt.y;
                  } else {
                    const rect = svg.getBoundingClientRect();
                    svgX = ((e.clientX - rect.left) / rect.width) * 1000;
                    svgY = ((e.clientY - rect.top) / rect.height) * 300;
                  }
                  const inChart =
                    svgX >= CHART_LEFT && svgX <= CHART_RIGHT && svgY >= CHART_TOP && svgY <= CHART_BOTTOM;
                  if (!inChart) {
                    setDefectTrendHover(null);
                    return;
                  }
                  const relX = svgX - CHART_LEFT;
                  const idx = len <= 1 ? 0 : Math.round((relX / chartW) * (len - 1));
                  const clampedIdx = Math.max(0, Math.min(idx, len - 1));
                  const d = trend[clampedIdx];
                  if (d) {
                    const x = indexToX(clampedIdx);
                    const y = toY(d.defectRate);
                    const mouseX = Math.max(CHART_LEFT, Math.min(CHART_RIGHT, svgX));
                    setDefectTrendHover({ index: clampedIdx, time: d.time, defectRate: d.defectRate, x, y, mouseX });
                  }
                };

                const handleDefectTrendMouseLeave = () => {
                  if (pinnedDefectTrendIndex === null) setDefectTrendHover(null);
                };

                const handleDefectTrendChartClick = (e: React.MouseEvent<SVGSVGElement>) => {
                  const svg = defectTrendSvgRef.current;
                  if (!svg || len === 0) return;
                  let svgX: number;
                  let svgY: number;
                  const ctm = svg.getScreenCTM();
                  if (ctm) {
                    const pt = svg.createSVGPoint();
                    pt.x = e.clientX;
                    pt.y = e.clientY;
                    const svgPt = pt.matrixTransform(ctm.inverse());
                    svgX = svgPt.x;
                    svgY = svgPt.y;
                  } else {
                    const rect = svg.getBoundingClientRect();
                    svgX = ((e.clientX - rect.left) / rect.width) * 1000;
                    svgY = ((e.clientY - rect.top) / rect.height) * 300;
                  }
                  const inChart =
                    svgX >= CHART_LEFT && svgX <= CHART_RIGHT && svgY >= CHART_TOP && svgY <= CHART_BOTTOM;
                  if (inChart) {
                    const relX = svgX - CHART_LEFT;
                    const idx = len <= 1 ? 0 : Math.round((relX / chartW) * (len - 1));
                    const clampedIdx = Math.max(0, Math.min(idx, len - 1));
                    setPinnedDefectTrendIndex((prev) => (prev === clampedIdx ? null : clampedIdx));
                    const d = trend[clampedIdx];
                    if (d) {
                      const x = indexToX(clampedIdx);
                      const y = toY(d.defectRate);
                      setDefectTrendTooltip({
                        time: d.time,
                        defectRate: d.defectRate,
                        xPct: (x / 1000) * 100,
                        yPct: (y / 300) * 100,
                        index: clampedIdx,
                      });
                    }
                  } else {
                    setPinnedDefectTrendIndex(null);
                    setDefectTrendTooltip(null);
                  }
                };

                const displayPoint =
                  pinnedDefectTrendIndex !== null && trend[pinnedDefectTrendIndex]
                    ? (() => {
                        const i = pinnedDefectTrendIndex;
                        const d = trend[i];
                        return {
                          index: i,
                          time: d.time,
                          defectRate: d.defectRate,
                          x: indexToX(i),
                          y: toY(d.defectRate),
                          mouseX: indexToX(i),
                        };
                      })()
                    : defectTrendHover;
                return (
                <Card title={language === 'ko' ? '불량률 추이 (최근 60일)' : 'Defect Rate Trend (Last 60 Days)'} className="lg:col-span-2">
                  <div
                    className="h-64 relative"
                    onClick={(e) => {
                      if (defectTrendSvgRef.current && !defectTrendSvgRef.current.contains(e.target as Node)) {
                        setPinnedDefectTrendIndex(null);
                        setDefectTrendTooltip(null);
                      }
                    }}
                  >
                    <svg
                      ref={defectTrendSvgRef}
                      className="w-full h-full cursor-crosshair"
                      viewBox="0 0 1000 300"
                      onMouseMove={handleDefectTrendMouseMove}
                      onMouseLeave={handleDefectTrendMouseLeave}
                      onClick={handleDefectTrendChartClick}
                    >
                      <defs>
                        <linearGradient id="passGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                          <stop offset="0%" stopColor="#22c55e" stopOpacity="0.3" />
                          <stop offset="100%" stopColor="#22c55e" stopOpacity="0" />
                        </linearGradient>
                      </defs>
                      {/* 그리드 라인 (데이터 기반 Y축 범위) */}
                      {yTicks.map((val) => (
                        <g key={val}>
                          <line
                            x1="60"
                            y1={toY(val)}
                            x2="950"
                            y2={toY(val)}
                            stroke="#e2e8f0"
                            strokeWidth="1"
                          />
                          <text
                            x="45"
                            y={toY(val) + 4}
                            fontSize="10"
                            fill="#64748b"
                            textAnchor="end"
                          >
                            {val.toFixed(1)}%
                          </text>
                        </g>
                      ))}
                      {/* 날짜가 바뀌는 위치에 세로 점선 */}
                      {dateBoundaryIndices.map((idx) => {
                        const x = 60 + (idx / Math.max(1, len - 1)) * 890;
                        return (
                          <line
                            key={idx}
                            x1={x}
                            y1={50}
                            x2={x}
                            y2={250}
                            stroke="#94a3b8"
                            strokeWidth="1"
                            strokeDasharray="4 4"
                          />
                        );
                      })}
                      {/* 불량률 차트: 선 + 일별 점 */}
                      {(() => {
                        const points = trend.map((d, i) => {
                          const x = indexToX(i);
                          const y = toY(d.defectRate);
                          return `${x},${y}`;
                        }).join(' ');
                        const linePathD = points ? `M ${points.replace(/ /g, ' L ')}` : '';
                        return (
                          <>
                            <path
                              d={linePathD}
                              fill="none"
                              stroke="#ef4444"
                              strokeWidth="3.5"
                              pathLength="100"
                              strokeDasharray="100"
                              style={{ animation: 'chart-line-draw 1.3s ease-out forwards' }}
                            />
                            {trend.map((d, i) => (
                              <circle
                                key={i}
                                cx={indexToX(i)}
                                cy={toY(d.defectRate)}
                                r="5"
                                fill="#ef4444"
                                pointerEvents="none"
                              >
                                <title>{d.time.slice(0, 10)}: {d.defectRate.toFixed(2)}%</title>
                              </circle>
                            ))}
                            {displayPoint && (
                              <g>
                                <line
                                  x1={displayPoint.mouseX}
                                  y1={CHART_TOP}
                                  x2={displayPoint.mouseX}
                                  y2={CHART_BOTTOM}
                                  stroke="#94a3b8"
                                  strokeWidth="0.5"
                                  strokeDasharray="2,2"
                                />
                                <circle
                                  cx={displayPoint.x}
                                  cy={displayPoint.y}
                                  r="7"
                                  fill="#ef4444"
                                  fillOpacity="0.3"
                                  stroke="#dc2626"
                                  strokeWidth="2"
                                />
                              </g>
                            )}
                          </>
                        );
                      })()}
                      {/* X축 레이블: M월 D일(한국어), 7일 간격, 2/22·2/23 숨김, 끝부분 겹침 방지 */}
                      {(() => {
                        const LABEL_INTERVAL_DAYS = 7;
                        const X_AXIS_HIDE_DATES = ['2026-02-22', '2026-02-23'];
                        const MIN_LABEL_PX = 80;
                        const indicesToShow = new Set<number>();
                        for (let i = 0; i < len; i += LABEL_INTERVAL_DAYS) indicesToShow.add(i);
                        if (len > 0) indicesToShow.add(len - 1);
                        const sorted = Array.from(indicesToShow).sort((a, b) => a - b);
                        const X_LABEL_Y = 286;
                        let lastX = -999;
                        return sorted.map((idx) => {
                          const dateKey = trend[idx].time.slice(0, 10);
                          if (X_AXIS_HIDE_DATES.includes(dateKey)) return null;
                          const x = 60 + (idx / Math.max(1, len - 1)) * 890;
                          if (x - lastX < MIN_LABEL_PX && lastX > -1) return null;
                          lastX = x;
                          const timeLabel = toMonthDayKo(dateKey) || (dateKey.match(/^\d{4}-(\d{2})-(\d{2})/) ? `${dateKey.slice(5, 7)}.${dateKey.slice(8, 10)}` : '');
                          return (
                            <text
                              key={`${dateKey}-${idx}`}
                              x={x}
                              y={X_LABEL_Y}
                              fontSize="10"
                              fontWeight="500"
                              fill="#334155"
                              textAnchor="middle"
                            >
                              {timeLabel}
                            </text>
                          );
                        }).filter(Boolean);
                      })()}
                    </svg>
                  </div>
                  <div className="min-h-[2rem] mt-2 flex items-center justify-center">
                    {displayPoint ? (
                      <p className="text-sm text-slate-600 truncate max-w-full">
                        <span className="font-medium">
                          {(() => {
                            const dt = new Date(displayPoint.time.length >= 10 ? displayPoint.time + 'T12:00:00' : displayPoint.time);
                            return Number.isNaN(dt.getTime()) ? displayPoint.time : dt.toLocaleDateString(language === 'ko' ? 'ko-KR' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' });
                          })()}
                        </span>
                        {' · '}
                        {language === 'ko' ? '불량률' : 'Defect rate'}: <strong>{displayPoint.defectRate.toFixed(2)}%</strong>
                        {pinnedDefectTrendIndex !== null && (
                          <span className="ml-2 text-xs text-slate-400">
                            ({language === 'ko' ? '← → 이동 · 그래프 클릭 시 해제' : '← → move · click chart to release'})
                          </span>
                        )}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex items-center justify-center gap-6 mt-2 text-sm">
                    <div className="flex items-center gap-2">
                      <div className="w-4 h-4 bg-red-500 rounded" />
                      <span className="text-slate-600">{language === 'ko' ? '불량률' : 'Defect Rate'}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-500">
                        {language === 'ko' ? '평균' : 'Avg'}: {avgDisplay.toFixed(2)}%
                      </span>
                    </div>
                  </div>
                  <p className="text-xs text-slate-500 text-center mt-1">
                    {language === 'ko'
                      ? '차트 위에 마우스를 올리면 세로 점선과 해당 일의 불량률이 표시됩니다. 클릭하면 고정됩니다.'
                      : 'Hover over the chart to see a vertical line and that day\'s defect rate. Click to pin.'}
                  </p>
                </Card>
                );
              })()}

            </div>
          )}
        </div>
      </main>
    </div>
  );
}
