import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../api/api';
import { useWs } from '../ws/WebSocketProvider';

function Content() {
  const { t } = useTranslation();
  const { initial } = useWs();
  const { specs, approvals, reloadAll } = useApi();
  const { info } = useApi();

  useEffect(() => {
    reloadAll();
  }, [reloadAll]);
  useEffect(() => {
    if (!initial) reloadAll();
  }, [initial, reloadAll]);

  const totalSpecs = specs.length;
  const totalTasks = specs.reduce((acc, s) => acc + (s.taskProgress?.total || 0), 0);
  const completedTasks = specs.reduce((acc, s) => acc + (s.taskProgress?.completed || 0), 0);
  const taskCompletionRate = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0;
  
  const taskSummary = totalSpecs > 0 
    ? t('stats.taskProgress.summary', { count: totalTasks, specs: totalSpecs })
    : t('stats.taskProgress.noActiveSpecs');

  return (
    <div className="space-y-8">
      {/* Project Header */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-1">
              {info?.projectName || t('projectNameDefault')}
            </h1>
            <p className="text-gray-600 dark:text-gray-400">
              {t('projectDescription')}
            </p>
          </div>
        </div>
      </div>


      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Specs Card */}
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-8 h-8 rounded bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
              <svg className="w-4 h-4 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <div className="text-sm font-medium text-gray-600 dark:text-gray-400">{t('stats.specifications.title')}</div>
          </div>
          <div className="text-2xl font-semibold text-gray-900 dark:text-white mb-1">{totalSpecs}</div>
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('stats.specifications.label')}</div>
        </div>

        {/* Tasks Card */}
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-8 h-8 rounded bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
              <svg className="w-4 h-4 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div className="text-sm font-medium text-gray-600 dark:text-gray-400">{t('stats.taskProgress.title')}</div>
          </div>
          <div className="flex items-baseline gap-2 mb-2">
            <div className="text-2xl font-semibold text-gray-900 dark:text-white">{completedTasks}</div>
            <div className="text-lg text-gray-600 dark:text-gray-400">/ {totalTasks}</div>
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400 mb-2">{taskSummary}</div>
          <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
            <div 
              className="bg-green-500 h-2 rounded-full transition-all duration-300"
              style={{ width: `${taskCompletionRate}%` }}
            />
          </div>
        </div>

        {/* Approvals Card */}
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
          <div className="flex items-center gap-3 mb-3">
            <div className={`w-8 h-8 rounded flex items-center justify-center ${approvals.length > 0 ? 'bg-amber-100 dark:bg-amber-900/30' : 'bg-purple-100 dark:bg-purple-900/30'}`}>
              <svg className={`w-4 h-4 ${approvals.length > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-purple-600 dark:text-purple-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {approvals.length > 0 ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                )}
              </svg>
            </div>
            <div className="text-sm font-medium text-gray-600 dark:text-gray-400">{t('stats.approvals.title')}</div>
          </div>
          <div className={`text-2xl font-semibold mb-1 ${approvals.length > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-900 dark:text-white'}`}>
            {approvals.length}
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400">
            {approvals.length > 0 ? t('stats.approvals.awaiting') : t('stats.approvals.allClear')}
          </div>
        </div>
      </div>

    </div>
  );
}

export function DashboardStatistics() {
  return <Content />;
}


