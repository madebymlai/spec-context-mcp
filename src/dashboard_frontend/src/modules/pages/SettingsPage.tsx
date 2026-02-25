import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRightIcon, ChevronDownIcon } from '@heroicons/react/24/solid';
import { AutomationJob } from '../../types';
import { JobFormModal } from './JobFormModal';
import { JobExecutionHistory } from './JobExecutionHistory';
import {
  buildRuntimeSettingsUpdatePayload,
  createEmptyRuntimeSettingsDraft,
  deriveRuntimeSettingsDraft,
  hasRuntimeSettingsChanges,
  type RuntimeSettingsDraft,
  type RuntimeSettingsFieldKey,
  type RuntimeSettingsResponse,
} from './settings-runtime-config';

interface JobUIState {
  id: string;
  name: string;
  type: 'cleanup-approvals' | 'cleanup-specs' | 'cleanup-archived-specs';
  enabled: boolean;
  daysOld: number;
  schedule: string;
  lastRun?: string;
  nextRun?: string;
}

function Content() {
  const { t } = useTranslation();
  const [jobs, setJobs] = useState<JobUIState[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  // Modal states
  const [showFormModal, setShowFormModal] = useState(false);
  const [editingJob, setEditingJob] = useState<AutomationJob | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [jobToDelete, setJobToDelete] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [expandedJobs, setExpandedJobs] = useState<Set<string>>(new Set());
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [runtimeSettings, setRuntimeSettings] = useState<RuntimeSettingsResponse | null>(null);
  const [runtimeDraft, setRuntimeDraft] = useState<RuntimeSettingsDraft>(createEmptyRuntimeSettingsDraft());
  const [initialRuntimeDraft, setInitialRuntimeDraft] = useState<RuntimeSettingsDraft>(createEmptyRuntimeSettingsDraft());
  const [runtimeLoading, setRuntimeLoading] = useState(true);
  const [runtimeSaving, setRuntimeSaving] = useState(false);

  const loadJobs = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/jobs');
      const data = await response.json();
      setJobs(data.map((job: AutomationJob) => ({
        id: job.id,
        name: job.name,
        type: job.type,
        enabled: job.enabled,
        daysOld: job.config.daysOld,
        schedule: job.schedule,
        lastRun: job.lastRun,
        nextRun: job.nextRun
      })));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load jobs');
    } finally {
      setLoading(false);
    }
  };

  const loadRuntimeSettings = async () => {
    try {
      setRuntimeLoading(true);
      const response = await fetch('/api/settings/runtime');
      const payload = await response.json().catch(() => null) as RuntimeSettingsResponse | { error?: string } | null;
      if (!response.ok) {
        const apiError = payload && typeof payload === 'object' && 'error' in payload
          ? payload.error
          : null;
        throw new Error(apiError || 'Failed to load runtime settings');
      }

      const resolved = payload as RuntimeSettingsResponse;
      const draft = deriveRuntimeSettingsDraft(resolved);
      setRuntimeSettings(resolved);
      setRuntimeDraft(draft);
      setInitialRuntimeDraft(draft);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load runtime settings');
    } finally {
      setRuntimeLoading(false);
    }
  };

  useEffect(() => {
    loadJobs();
    loadRuntimeSettings();
  }, []);

  const handleToggleJob = async (jobId: string, enabled: boolean) => {
    try {
      const response = await fetch(`/api/jobs/${jobId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !enabled })
      });

      if (response.ok) {
        setJobs(jobs.map(j => j.id === jobId ? { ...j, enabled: !j.enabled } : j));
        setError(null);
      } else {
        setError('Failed to update job');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update job');
    }
  };

  const handleRunJob = async (jobId: string) => {
    try {
      setRunning(prev => ({ ...prev, [jobId]: true }));
      const response = await fetch(`/api/jobs/${jobId}/run`, { method: 'POST' });
      const result = await response.json();

      if (response.ok) {
        // Update last run time
        setJobs(jobs.map(j => j.id === jobId ? { ...j, lastRun: result.startTime } : j));
        setError(null);
      } else {
        setError(result.error || 'Failed to run job');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run job');
    } finally {
      setRunning(prev => ({ ...prev, [jobId]: false }));
    }
  };

  const handleFormSubmit = async (formJob: Omit<AutomationJob, 'lastRun' | 'nextRun'>) => {
    try {
      setIsSubmitting(true);
      setError(null);

      if (editingJob) {
        // Update existing job
        const response = await fetch(`/api/jobs/${formJob.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: formJob.name,
            enabled: formJob.enabled,
            config: formJob.config,
            schedule: formJob.schedule
          })
        });

        if (response.ok) {
          // Reload jobs after update
          await loadJobs();
          setShowFormModal(false);
          setEditingJob(null);
        } else {
          const result = await response.json();
          throw new Error(result.error || 'Failed to update job');
        }
      } else {
        // Create new job
        const response = await fetch('/api/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(formJob)
        });

        if (response.ok) {
          // Reload jobs after creation
          await loadJobs();
          setShowFormModal(false);
        } else {
          const result = await response.json();
          throw new Error(result.error || 'Failed to create job');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save job');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteJob = async () => {
    if (!jobToDelete) return;

    try {
      const response = await fetch(`/api/jobs/${jobToDelete}`, { method: 'DELETE' });

      if (response.ok) {
        setJobs(jobs.filter(j => j.id !== jobToDelete));
        setJobToDelete(null);
        setShowDeleteModal(false);
        setError(null);
      } else {
        setError('Failed to delete job');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete job');
    }
  };

  const getJobTypeLabel = (type: string) => {
    const typeMap: Record<string, string> = {
      'cleanup-approvals': 'Cleanup Approvals',
      'cleanup-specs': 'Cleanup Specs',
      'cleanup-archived-specs': 'Cleanup Archived Specs'
    };
    return typeMap[type] || type;
  };

  const toggleJobExpanded = (jobId: string) => {
    const newExpanded = new Set(expandedJobs);
    if (newExpanded.has(jobId)) {
      newExpanded.delete(jobId);
    } else {
      newExpanded.add(jobId);
    }
    setExpandedJobs(newExpanded);
  };

  const toggleSectionExpanded = (sectionId: string) => {
    const newExpanded = new Set(expandedSections);
    if (newExpanded.has(sectionId)) {
      newExpanded.delete(sectionId);
    } else {
      newExpanded.add(sectionId);
    }
    setExpandedSections(newExpanded);
  };

  const formatLastRun = (dateStr?: string) => {
    if (!dateStr) return 'Never';
    const date = new Date(dateStr);
    return date.toLocaleString();
  };

  const getRuntimeFallbackPlaceholder = (field: RuntimeSettingsFieldKey) => {
    if (!runtimeSettings) {
      return '';
    }

    const setting = runtimeSettings[field];
    if (setting.source === 'json') {
      return '';
    }

    const sourceLabel = setting.source === 'env'
      ? t('settings.runtime.source.env', '.env')
      : t('settings.runtime.source.default', 'default');
    const fallbackValue = setting.value || t('settings.runtime.source.none', 'none');
    return t('settings.runtime.fallbackTemplate', '{{value}} (from {{source}})', {
      value: fallbackValue,
      source: sourceLabel,
    });
  };

  const handleRuntimeFieldChange = (field: RuntimeSettingsFieldKey, value: string) => {
    setRuntimeDraft((currentDraft) => ({
      ...currentDraft,
      [field]: value === '' ? null : value,
    }));
  };

  const handleRuntimeFieldClear = (field: RuntimeSettingsFieldKey) => {
    setRuntimeDraft((currentDraft) => ({
      ...currentDraft,
      [field]: null,
    }));
  };

  const hasRuntimeChanges = hasRuntimeSettingsChanges(initialRuntimeDraft, runtimeDraft);

  const saveRuntimeSettings = async () => {
    const updates = buildRuntimeSettingsUpdatePayload(initialRuntimeDraft, runtimeDraft);
    if (Object.keys(updates).length === 0) {
      return;
    }

    try {
      setRuntimeSaving(true);
      const response = await fetch('/api/settings/runtime', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });

      const payload = await response.json().catch(() => null) as RuntimeSettingsResponse | { error?: string } | null;
      if (!response.ok) {
        const apiError = payload && typeof payload === 'object' && 'error' in payload
          ? payload.error
          : null;
        throw new Error(apiError || 'Failed to save runtime settings');
      }

      const resolved = payload as RuntimeSettingsResponse;
      const draft = deriveRuntimeSettingsDraft(resolved);
      setRuntimeSettings(resolved);
      setRuntimeDraft(draft);
      setInitialRuntimeDraft(draft);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save runtime settings');
    } finally {
      setRuntimeSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-1">
              {t('settings.title', 'Settings')}
            </h1>
            <p className="text-gray-600 dark:text-gray-400">
              {t('settings.description', 'Manage automated cleanup jobs that run across all connected projects')}
            </p>
          </div>
        </div>
      </div>

      {/* Error Alert */}
      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
          <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
        </div>
      )}

      {/* Loading State */}
      {loading && (
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-8">
          <div className="flex items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            <span className="ml-3 text-gray-600 dark:text-gray-400">
              {t('settings.loading', 'Loading jobs...')}
            </span>
          </div>
        </div>
      )}

      {/* Runtime Configuration Section */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        {/* Section Header */}
        <button
          onClick={() => toggleSectionExpanded('runtimeConfiguration')}
          className="w-full px-6 py-4 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
        >
          <div className="flex items-center gap-3 flex-1 text-left">
            <ChevronRightIcon className={`w-5 h-5 text-gray-600 dark:text-gray-400 transition-transform ${expandedSections.has('runtimeConfiguration') ? 'rotate-90' : ''}`} />
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                {t('settings.section.runtimeConfiguration', 'Runtime Configuration')}
              </h2>
            </div>
          </div>
        </button>

        {expandedSections.has('runtimeConfiguration') && (
          <div className="border-t border-gray-200 dark:border-gray-700 p-6 space-y-6">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {t('settings.section.runtimeConfigurationDesc', 'Override runtime dispatch settings. Empty values fall back to environment variables or defaults.')}
            </p>

            {runtimeLoading ? (
              <div className="flex items-center gap-3">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
                <span className="text-sm text-gray-600 dark:text-gray-400">
                  {t('settings.runtime.loading', 'Loading runtime settings...')}
                </span>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      {t('settings.runtime.discipline', 'Discipline mode')}
                    </label>
                    <select
                      value={runtimeDraft.discipline ?? 'full'}
                      onChange={(event) => handleRuntimeFieldChange('discipline', event.target.value)}
                      className="w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white"
                    >
                      <option value="full">{t('settings.runtime.disciplineFull', 'full')}</option>
                      <option value="standard">{t('settings.runtime.disciplineStandard', 'standard')}</option>
                      <option value="minimal">{t('settings.runtime.disciplineMinimal', 'minimal')}</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      {t('settings.runtime.implementerProvider', 'Implementer provider')}
                    </label>
                    <div className="flex items-center gap-2">
                      <select
                        value={runtimeDraft.implementer ?? ''}
                        onChange={(event) => handleRuntimeFieldChange('implementer', event.target.value)}
                        className="w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white"
                      >
                        <option value="">{getRuntimeFallbackPlaceholder('implementer') || t('settings.runtime.noneOption', 'empty')}</option>
                        <option value="claude">claude</option>
                        <option value="codex">codex</option>
                        <option value="gemini">gemini</option>
                        <option value="opencode">opencode</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => handleRuntimeFieldClear('implementer')}
                        className="w-8 h-8 rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                        title={t('settings.runtime.clear', 'Clear')}
                      >
                        X
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      {t('settings.runtime.reviewerProvider', 'Reviewer provider')}
                    </label>
                    <div className="flex items-center gap-2">
                      <select
                        value={runtimeDraft.reviewer ?? ''}
                        onChange={(event) => handleRuntimeFieldChange('reviewer', event.target.value)}
                        className="w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white"
                      >
                        <option value="">{getRuntimeFallbackPlaceholder('reviewer') || t('settings.runtime.noneOption', 'empty')}</option>
                        <option value="claude">claude</option>
                        <option value="codex">codex</option>
                        <option value="gemini">gemini</option>
                        <option value="opencode">opencode</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => handleRuntimeFieldClear('reviewer')}
                        className="w-8 h-8 rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                        title={t('settings.runtime.clear', 'Clear')}
                      >
                        X
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      {t('settings.runtime.implementerReasoningEffort', 'Implementer reasoning effort')}
                    </label>
                    <div className="flex items-center gap-2">
                      <select
                        value={runtimeDraft.implementerReasoningEffort ?? ''}
                        onChange={(event) => handleRuntimeFieldChange('implementerReasoningEffort', event.target.value)}
                        className="w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white"
                      >
                        <option value="">{getRuntimeFallbackPlaceholder('implementerReasoningEffort') || t('settings.runtime.noneOption', 'empty')}</option>
                        <option value="minimal">{t('settings.runtime.reasoningMinimal', 'minimal')}</option>
                        <option value="low">{t('settings.runtime.reasoningLow', 'low')}</option>
                        <option value="medium">{t('settings.runtime.reasoningMedium', 'medium')}</option>
                        <option value="high">{t('settings.runtime.reasoningHigh', 'high')}</option>
                        <option value="xhigh">{t('settings.runtime.reasoningXhigh', 'xhigh')}</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => handleRuntimeFieldClear('implementerReasoningEffort')}
                        className="w-8 h-8 rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                        title={t('settings.runtime.clear', 'Clear')}
                      >
                        X
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      {t('settings.runtime.reviewerReasoningEffort', 'Reviewer reasoning effort')}
                    </label>
                    <div className="flex items-center gap-2">
                      <select
                        value={runtimeDraft.reviewerReasoningEffort ?? ''}
                        onChange={(event) => handleRuntimeFieldChange('reviewerReasoningEffort', event.target.value)}
                        className="w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white"
                      >
                        <option value="">{getRuntimeFallbackPlaceholder('reviewerReasoningEffort') || t('settings.runtime.noneOption', 'empty')}</option>
                        <option value="minimal">{t('settings.runtime.reasoningMinimal', 'minimal')}</option>
                        <option value="low">{t('settings.runtime.reasoningLow', 'low')}</option>
                        <option value="medium">{t('settings.runtime.reasoningMedium', 'medium')}</option>
                        <option value="high">{t('settings.runtime.reasoningHigh', 'high')}</option>
                        <option value="xhigh">{t('settings.runtime.reasoningXhigh', 'xhigh')}</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => handleRuntimeFieldClear('reviewerReasoningEffort')}
                        className="w-8 h-8 rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                        title={t('settings.runtime.clear', 'Clear')}
                      >
                        X
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      {t('settings.runtime.implementerModelSimple', 'Implementer model (simple)')}
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={runtimeDraft.implementerModelSimple ?? ''}
                        onChange={(event) => handleRuntimeFieldChange('implementerModelSimple', event.target.value)}
                        placeholder={getRuntimeFallbackPlaceholder('implementerModelSimple')}
                        className="w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400"
                      />
                      <button
                        type="button"
                        onClick={() => handleRuntimeFieldClear('implementerModelSimple')}
                        className="w-8 h-8 rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                        title={t('settings.runtime.clear', 'Clear')}
                      >
                        X
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      {t('settings.runtime.implementerModelComplex', 'Implementer model (complex)')}
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={runtimeDraft.implementerModelComplex ?? ''}
                        onChange={(event) => handleRuntimeFieldChange('implementerModelComplex', event.target.value)}
                        placeholder={getRuntimeFallbackPlaceholder('implementerModelComplex')}
                        className="w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400"
                      />
                      <button
                        type="button"
                        onClick={() => handleRuntimeFieldClear('implementerModelComplex')}
                        className="w-8 h-8 rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                        title={t('settings.runtime.clear', 'Clear')}
                      >
                        X
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      {t('settings.runtime.reviewerModelSimple', 'Reviewer model (simple)')}
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={runtimeDraft.reviewerModelSimple ?? ''}
                        onChange={(event) => handleRuntimeFieldChange('reviewerModelSimple', event.target.value)}
                        placeholder={getRuntimeFallbackPlaceholder('reviewerModelSimple')}
                        className="w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400"
                      />
                      <button
                        type="button"
                        onClick={() => handleRuntimeFieldClear('reviewerModelSimple')}
                        className="w-8 h-8 rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                        title={t('settings.runtime.clear', 'Clear')}
                      >
                        X
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      {t('settings.runtime.reviewerModelComplex', 'Reviewer model (complex)')}
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={runtimeDraft.reviewerModelComplex ?? ''}
                        onChange={(event) => handleRuntimeFieldChange('reviewerModelComplex', event.target.value)}
                        placeholder={getRuntimeFallbackPlaceholder('reviewerModelComplex')}
                        className="w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400"
                      />
                      <button
                        type="button"
                        onClick={() => handleRuntimeFieldClear('reviewerModelComplex')}
                        className="w-8 h-8 rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                        title={t('settings.runtime.clear', 'Clear')}
                      >
                        X
                      </button>
                    </div>
                  </div>
                </div>

                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={saveRuntimeSettings}
                    disabled={runtimeSaving || !hasRuntimeChanges}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {runtimeSaving
                      ? t('settings.runtime.saving', 'Saving...')
                      : t('settings.runtime.save', 'Save Runtime Settings')}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Automated Cleanup Section */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        {/* Section Header */}
        <button
          onClick={() => toggleSectionExpanded('automatedCleanup')}
          className="w-full px-6 py-4 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
        >
          <div className="flex items-center gap-3 flex-1 text-left">
            <ChevronRightIcon className={`w-5 h-5 text-gray-600 dark:text-gray-400 transition-transform ${expandedSections.has('automatedCleanup') ? 'rotate-90' : ''}`} />
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                {t('settings.section.automatedCleanup', 'Automated Cleanup')}
              </h2>
            </div>
          </div>
        </button>

        {/* Section Description and Content */}
        {expandedSections.has('automatedCleanup') && (
          <div className="border-t border-gray-200 dark:border-gray-700 p-6 space-y-6">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {t('settings.section.automatedCleanupDesc', 'Automatically delete old approval records, specifications, and archived specifications based on a schedule. Configure cleanup jobs to run on a recurring basis across all connected projects.')}
            </p>

            {/* Add Job Button */}
            <div className="flex justify-end">
              <button
                onClick={() => {
                  setEditingJob(null);
                  setShowFormModal(true);
                }}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {t('settings.addJob', 'Add Job')}
              </button>
            </div>

            {/* Jobs List */}
            {!loading && jobs.length === 0 && (
              <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg border border-gray-200 dark:border-gray-600 p-8">
                <div className="text-center">
                  <svg className="w-12 h-12 text-gray-400 dark:text-gray-600 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-1">
                    {t('settings.noJobs', 'No automation jobs')}
                  </h3>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
                    {t('settings.noJobsDesc', 'Create your first automation job to get started')}
                  </p>
                  <button
                    onClick={() => {
                      setEditingJob(null);
                      setShowFormModal(true);
                    }}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
                  >
                    {t('settings.createFirst', 'Create First Job')}
                  </button>
                </div>
              </div>
            )}

            {/* Jobs Grid */}
            {!loading && jobs.length > 0 && (
              <div className="grid grid-cols-1 gap-4">
                {jobs.map((job) => (
          <div key={job.id} className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
            <div className="p-6">
              <div className="flex items-start justify-between mb-4">
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-2">
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{job.name}</h3>
                  <span className="px-2 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 text-xs font-medium rounded">
                    {getJobTypeLabel(job.type)}
                  </span>
                </div>
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
                  {t('settings.jobDescription', 'Delete records older than {{days}} days on schedule: {{schedule}}', {
                    days: job.daysOld,
                    schedule: job.schedule
                  })}
                </p>

                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div>
                    <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mb-1">
                      {t('settings.lastRun', 'Last Run')}
                    </label>
                    <p className="text-sm text-gray-900 dark:text-white">{formatLastRun(job.lastRun)}</p>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mb-1">
                      {t('settings.schedule', 'Schedule')}
                    </label>
                    <p className="text-sm text-gray-900 dark:text-white font-mono">{job.schedule}</p>
                  </div>
                </div>
              </div>

              {/* Expand/Collapse and Toggle */}
              <div className="flex flex-col gap-2 ml-4 items-end">
                <button
                  type="button"
                  onClick={() => toggleJobExpanded(job.id)}
                  className="flex items-center gap-1 text-sm text-blue-600 dark:text-blue-400 hover:underline"
                >
                  {expandedJobs.has(job.id) ? (
                    <ChevronDownIcon className="w-4 h-4" />
                  ) : (
                    <ChevronRightIcon className="w-4 h-4" />
                  )}
                  History
                </button>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={job.enabled}
                    onChange={() => handleToggleJob(job.id, job.enabled)}
                    className="w-5 h-5 rounded"
                  />
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    {job.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </label>
              </div>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex gap-2 pt-4 border-t border-gray-200 dark:border-gray-700">
              <button
                onClick={() => handleRunJob(job.id)}
                disabled={running[job.id] || !job.enabled}
                className="flex-1 px-3 py-2 bg-green-100 hover:bg-green-200 dark:bg-green-900/30 dark:hover:bg-green-900/50 text-green-700 dark:text-green-400 text-sm font-medium rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {running[job.id] ? (
                  <>
                    <span className="inline-block mr-2 animate-spin">⟳</span>
                    {t('settings.running', 'Running...')}
                  </>
                ) : (
                  t('settings.runNow', 'Run Now')
                )}
              </button>
              <button
                onClick={() => {
                  const fullJob = {
                    id: job.id,
                    name: job.name,
                    type: job.type,
                    enabled: job.enabled,
                    config: { daysOld: job.daysOld },
                    schedule: job.schedule,
                    lastRun: job.lastRun,
                    nextRun: job.nextRun,
                    createdAt: new Date().toISOString()
                  };
                  setEditingJob(fullJob);
                  setShowFormModal(true);
                }}
                className="flex-1 px-3 py-2 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 text-sm font-medium rounded transition-colors"
              >
                {t('settings.edit', 'Edit')}
              </button>
              <button
                onClick={() => {
                  setJobToDelete(job.id);
                  setShowDeleteModal(true);
                }}
                className="flex-1 px-3 py-2 bg-red-100 hover:bg-red-200 dark:bg-red-900/30 dark:hover:bg-red-900/50 text-red-700 dark:text-red-400 text-sm font-medium rounded transition-colors"
              >
                {t('settings.delete', 'Delete')}
              </button>
            </div>

            {/* Execution History */}
            <JobExecutionHistory jobId={job.id} isExpanded={expandedJobs.has(job.id)} />
          </div>
        ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Job Form Modal */}
      <JobFormModal
        isOpen={showFormModal}
        onClose={() => {
          setShowFormModal(false);
          setEditingJob(null);
        }}
        onSubmit={handleFormSubmit}
        initialJob={editingJob}
        isLoading={isSubmitting}
      />

      {/* Delete Confirmation Modal */}
      {showDeleteModal && jobToDelete && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
              {t('settings.deleteJob', 'Delete Job')}
            </h2>
            <p className="text-gray-600 dark:text-gray-400 mb-6">
              {t('settings.deleteConfirm', 'Are you sure you want to delete this automation job? This action cannot be undone.')}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setShowDeleteModal(false);
                  setJobToDelete(null);
                }}
                className="flex-1 px-4 py-2 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded transition-colors"
              >
                {t('settings.cancel', 'Cancel')}
              </button>
              <button
                onClick={handleDeleteJob}
                className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded transition-colors"
              >
                {t('settings.delete', 'Delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function SettingsPage() {
  return <Content />;
}
