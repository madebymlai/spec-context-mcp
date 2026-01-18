import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

export type AiModel = 'deepseek-v3' | 'deepseek-v3-reasoning' | 'gemini-flash';

export interface AiSuggestion {
  quote?: string;
  comment: string;
}

interface AiReviewButtonProps {
  onReviewComplete: (suggestions: AiSuggestion[], model: AiModel) => void;
  onReviewStart?: () => void;
  onError?: (error: string) => void;
  aiReview: (approvalId: string, model: string) => Promise<{ success: boolean; model: string; suggestions: AiSuggestion[] }>;
  approvalId: string;
  disabled?: boolean;
}

const AI_MODELS: { id: AiModel; label: string; description: string }[] = [
  { id: 'deepseek-v3', label: 'DeepSeek V3', description: 'Fast' },
  { id: 'deepseek-v3-reasoning', label: 'DeepSeek V3 (Reasoning)', description: 'Thorough' },
  { id: 'gemini-flash', label: 'Gemini Flash', description: 'Fast' },
];

export function AiReviewButton({
  onReviewComplete,
  onReviewStart,
  onError,
  aiReview,
  approvalId,
  disabled = false,
}: AiReviewButtonProps) {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);

  const handleModelSelect = async (model: AiModel) => {
    setShowDropdown(false);
    setIsLoading(true);
    onReviewStart?.();

    try {
      const result = await aiReview(approvalId, model);
      if (result.success && result.suggestions) {
        onReviewComplete(result.suggestions, model);
      } else {
        onError?.(t('aiReview.error', 'AI review failed'));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onError?.(message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setShowDropdown(!showDropdown)}
        disabled={disabled || isLoading}
        className="btn bg-violet-600 hover:bg-violet-700 focus:ring-violet-500 text-xs sm:text-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1 min-w-0 touch-manipulation"
      >
        {isLoading ? (
          <svg className="animate-spin w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        ) : (
          <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
          </svg>
        )}
        <span className="hidden sm:inline">{isLoading ? t('aiReview.loading', 'Analyzing...') : t('aiReview.button', 'AI Review')}</span>
        <span className="sm:hidden">{isLoading ? '...' : 'AI'}</span>
        {!isLoading && (
          <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </button>

      {showDropdown && !isLoading && (
        <>
          {/* Backdrop to close dropdown */}
          <div
            className="fixed inset-0 z-[100]"
            onClick={() => setShowDropdown(false)}
          />

          {/* Dropdown menu */}
          <div className="absolute left-0 mt-1 w-56 rounded-md shadow-lg bg-white dark:bg-gray-800 ring-1 ring-black ring-opacity-5 z-[101]">
            <div className="py-1">
              {AI_MODELS.map((model) => (
                <button
                  key={model.id}
                  onClick={() => handleModelSelect(model.id)}
                  className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center justify-between"
                >
                  <span>{model.label}</span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">{model.description}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
