export const AI_SUMMARY_LIMIT = 50;
export const AI_SUMMARY_SCOPE = `Last ${AI_SUMMARY_LIMIT} messages`;
export const AI_THREAD_SCOPE = 'This thread';

export function formatAiActionError(err, fallback) {
  if (err?.name === 'AbortError') {
    return 'Cancelled.';
  }
  if (err?.status === 429) {
    return 'AI service is queued. Please try again shortly.';
  }
  if (err?.status === 503) {
    return 'AI service is unavailable. Please try again shortly.';
  }
  return err?.message || fallback;
}

// Cross-channel "Catch Me Up" workspace digest (FEATURE_REQUEST.md entry 6).
// Fixed set of window choices for WorkspaceDigestPanel.jsx's radio group —
// mirrors AI_SUMMARY_SCOPE's "state the scope in plain language" precedent,
// one level up (a time window instead of a message count).
export const AI_DIGEST_WINDOW_OPTIONS = [
  { sinceHours: 24, label: 'Last 24 hours' },
  { sinceHours: 72, label: 'Last 3 days' },
  { sinceHours: 168, label: 'Last 7 days' },
];
