import React from 'react';
import { useTranslation } from 'react-i18next';

interface AiSuggestionCardProps {
  quote?: string;
  comment: string;
  highlightColor?: { bg: string; border: string; name: string };
  onApprove: () => void;
  onReject: () => void;
  onClick?: () => void;
}

export function AiSuggestionCard({
  quote,
  comment,
  highlightColor,
  onApprove,
  onReject,
  onClick,
}: AiSuggestionCardProps) {
  const { t } = useTranslation();

  const handleCardClick = (e: React.MouseEvent) => {
    // Don't trigger onClick if clicking the action buttons
    if ((e.target as HTMLElement).closest('button')) {
      return;
    }
    onClick?.();
  };

  return (
    <div
      onClick={handleCardClick}
      className={`bg-gray-50 dark:bg-gray-700 rounded-lg border border-gray-200 dark:border-gray-600 p-3 ${onClick ? 'cursor-pointer hover:border-gray-300 dark:hover:border-gray-500' : ''}`}
    >
      {/* AI Badge */}
      <div className="flex items-center gap-2 mb-2">
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-violet-100 text-violet-800 dark:bg-violet-900 dark:text-violet-200">
          <svg className="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
          </svg>
          {t('aiSuggestions.badge', 'AI Suggestion')}
        </span>
      </div>

      {/* Quoted text if present */}
      {quote && (
        <div
          className="text-sm mb-2 p-2 rounded border-l-4"
          style={{
            backgroundColor: highlightColor?.bg || '#FEF3C7',
            borderLeftColor: highlightColor?.border || '#F59E0B',
          }}
        >
          <span className="text-gray-700 dark:text-gray-800 italic">"{quote}"</span>
        </div>
      )}

      {/* Comment */}
      <p className="text-sm text-gray-700 dark:text-gray-300 mb-3">
        {comment}
      </p>

      {/* Action buttons */}
      <div className="flex items-center gap-2">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onApprove();
          }}
          className="inline-flex items-center px-2 py-1 text-xs font-medium rounded bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900 dark:text-green-300 dark:hover:bg-green-800 transition-colors"
        >
          <svg className="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
          </svg>
          {t('aiSuggestions.approve', 'Approve')}
        </button>

        <button
          onClick={(e) => {
            e.stopPropagation();
            onReject();
          }}
          className="inline-flex items-center px-2 py-1 text-xs font-medium rounded bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900 dark:text-red-300 dark:hover:bg-red-800 transition-colors"
        >
          <svg className="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
          {t('aiSuggestions.reject', 'Reject')}
        </button>
      </div>
    </div>
  );
}
