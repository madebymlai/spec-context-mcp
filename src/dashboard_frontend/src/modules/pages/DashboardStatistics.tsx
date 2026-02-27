import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi, type AnalyticsHistoryPoint } from '../api/api';
import { useWs } from '../ws/WebSocketProvider';

// Circular Progress Component
function CircularProgress({ 
  percentage, 
  size = 40, 
  strokeWidth = 3, 
  color = 'stroke-emerald-500',
  bgColor = 'stroke-gray-200 dark:stroke-gray-700'
}: { 
  percentage: number; 
  size?: number; 
  strokeWidth?: number;
  color?: string;
  bgColor?: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - (percentage / 100) * circumference;

  return (
    <svg width={size} height={size} className="transform -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" className={bgColor} strokeWidth={strokeWidth} />
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" className={`${color} transition-all duration-500`} strokeWidth={strokeWidth} strokeDasharray={circumference} strokeDashoffset={offset} strokeLinecap="round" />
    </svg>
  );
}

function Content() {
  const { t } = useTranslation();
  const { initial } = useWs();
  const { specs, archivedSpecs, approvals, reloadAll, info, getAnalyticsHistory } = useApi();
  const [historyPoints, setHistoryPoints] = useState<AnalyticsHistoryPoint[]>([]);
  const [historyWindowDays, setHistoryWindowDays] = useState(30);
  const [historyLoading, setHistoryLoading] = useState(true);

  useEffect(() => {
    reloadAll();
  }, [reloadAll]);
  useEffect(() => {
    if (!initial) reloadAll();
  }, [initial, reloadAll]);

  useEffect(() => {
    let cancelled = false;
    const loadHistory = async () => {
      setHistoryLoading(true);
      try {
        const response = await getAnalyticsHistory(30);
        if (cancelled) {
          return;
        }
        setHistoryPoints(response.points);
        setHistoryWindowDays(response.windowDays);
      } catch (error) {
        if (!cancelled) {
          setHistoryPoints([]);
          setHistoryWindowDays(30);
        }
        console.error('Failed to load analytics history:', error);
      } finally {
        if (!cancelled) {
          setHistoryLoading(false);
        }
      }
    };

    loadHistory();
    return () => {
      cancelled = true;
    };
  }, [getAnalyticsHistory, specs, archivedSpecs, approvals]);

  // Core metrics
  const totalSpecs = specs.length;
  const totalArchivedSpecs = archivedSpecs.length;
  const totalTasks = specs.reduce((acc, s) => acc + (s.taskProgress?.total || 0), 0);
  const completedTasks = specs.reduce((acc, s) => acc + (s.taskProgress?.completed || 0), 0);
  const taskCompletionRate = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0;
  
  // Approval metrics
  const pendingApprovals = approvals.filter(a => a.status === 'pending').length;
  const approvedCount = approvals.filter(a => a.status === 'approved').length;
  const needsRevisionCount = approvals.filter(a => a.status === 'needs-revision').length;
  const trendPoints = historyPoints.map((point) => ({
    ...point,
    totalActivity:
      point.specsCreated
      + point.specsModified
      + point.approvalsCreated
      + point.approvalsResolved,
  }));
  const maxTrendActivity = trendPoints.reduce((max, point) => Math.max(max, point.totalActivity), 0);
  const trendTotals = trendPoints.reduce(
    (aggregate, point) => ({
      specsCreated: aggregate.specsCreated + point.specsCreated,
      specsModified: aggregate.specsModified + point.specsModified,
      approvalsCreated: aggregate.approvalsCreated + point.approvalsCreated,
      approvalsResolved: aggregate.approvalsResolved + point.approvalsResolved,
    }),
    {
      specsCreated: 0,
      specsModified: 0,
      approvalsCreated: 0,
      approvalsResolved: 0,
    }
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-br from-slate-700 via-slate-800 to-slate-900 rounded-xl p-6 text-white">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-medium text-slate-400 uppercase tracking-wider">{t('stats.analyticsDashboard')}</span>
        </div>
        <h1 className="text-2xl font-bold">{info?.projectName || t('projectNameDefault')}</h1>
        <p className="text-slate-400 text-sm mt-1">{t('projectDescription')}</p>
      </div>

      {/* KPI Cards - 3 columns */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Total Specs */}
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
          <div className="flex items-start justify-between mb-2">
            <div className="w-9 h-9 rounded-lg bg-slate-100 dark:bg-slate-700 flex items-center justify-center">
              <svg className="w-4 h-4 text-slate-600 dark:text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
          </div>
          <div className="text-3xl font-bold text-gray-900 dark:text-white">{totalSpecs}</div>
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('stats.specifications.label')}</div>
          {totalArchivedSpecs > 0 && (
            <div className="mt-1 text-xs text-gray-400">+{totalArchivedSpecs} {t('stats.archived')}</div>
          )}
        </div>

        {/* Task Completion */}
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
          <div className="flex items-start justify-between mb-2">
            <div className="w-9 h-9 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
              <svg className="w-4 h-4 text-emerald-600 dark:text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <CircularProgress percentage={taskCompletionRate} size={32} strokeWidth={3} />
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-3xl font-bold text-gray-900 dark:text-white">{completedTasks}</span>
            <span className="text-sm text-gray-500 dark:text-gray-400">/ {totalTasks}</span>
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('stats.tasksCompleted')}</div>
        </div>

        {/* Pending Approvals */}
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
          <div className="flex items-start justify-between mb-2">
            <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${pendingApprovals > 0 ? 'bg-amber-100 dark:bg-amber-900/30' : 'bg-violet-100 dark:bg-violet-900/30'}`}>
              <svg className={`w-4 h-4 ${pendingApprovals > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-violet-600 dark:text-violet-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
          </div>
          <div className="text-3xl font-bold text-gray-900 dark:text-white">{pendingApprovals}</div>
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('stats.pendingApprovals')}</div>
          {(approvedCount > 0 || needsRevisionCount > 0) && (
            <div className="mt-1 flex gap-2 text-xs">
              {approvedCount > 0 && <span className="text-emerald-600 dark:text-emerald-400">{approvedCount} approved</span>}
              {needsRevisionCount > 0 && <span className="text-rose-600 dark:text-rose-400">{needsRevisionCount} revision</span>}
            </div>
          )}
        </div>
      </div>

      {/* Historical Trend */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
        <div className="p-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">Historical Activity Trend</h3>
            <span className="text-xs text-gray-500 dark:text-gray-400">Last {historyWindowDays} days</span>
          </div>
        </div>
        <div className="p-4">
          {historyLoading ? (
            <div className="text-sm text-gray-500 dark:text-gray-400">Loading trend data...</div>
          ) : trendPoints.length === 0 ? (
            <div className="text-sm text-gray-500 dark:text-gray-400">No historical activity yet.</div>
          ) : (
            <>
              <div className="h-44 flex items-end gap-1">
                {trendPoints.map((point) => {
                  const heightPercent = maxTrendActivity > 0
                    ? Math.max(6, (point.totalActivity / maxTrendActivity) * 100)
                    : 6;
                  return (
                    <div key={point.date} className="flex-1 min-w-[4px] max-w-3">
                      <div className="group relative h-36 flex items-end">
                        <div
                          className="w-full rounded-t bg-sky-500/80 dark:bg-sky-400/70 transition-all duration-300"
                          style={{ height: `${heightPercent}%` }}
                        />
                        <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block bg-gray-900 text-white text-[10px] rounded px-2 py-1 whitespace-nowrap z-10">
                          {point.date}: {point.totalActivity}
                        </div>
                      </div>
                      <div className="mt-1 text-[10px] text-center text-gray-500 dark:text-gray-400">
                        {point.date.slice(5)}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                <div className="bg-gray-50 dark:bg-gray-700/40 rounded p-2 text-gray-700 dark:text-gray-300">Specs created: {trendTotals.specsCreated}</div>
                <div className="bg-gray-50 dark:bg-gray-700/40 rounded p-2 text-gray-700 dark:text-gray-300">Specs updated: {trendTotals.specsModified}</div>
                <div className="bg-gray-50 dark:bg-gray-700/40 rounded p-2 text-gray-700 dark:text-gray-300">Approvals created: {trendTotals.approvalsCreated}</div>
                <div className="bg-gray-50 dark:bg-gray-700/40 rounded p-2 text-gray-700 dark:text-gray-300">Approvals resolved: {trendTotals.approvalsResolved}</div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function DashboardStatistics() {
  return <Content />;
}
