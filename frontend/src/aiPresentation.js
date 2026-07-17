export const AI_SUMMARY_LIMIT = 50;
export const AI_SUMMARY_SCOPE = `Last ${AI_SUMMARY_LIMIT} messages`;
export const AI_THREAD_SCOPE = 'This thread';

export function formatAiActionError(err, fallback) {
  if (err?.status === 429) {
    return 'AI service is queued. Please try again shortly.';
  }
  if (err?.status === 503) {
    return 'AI service is unavailable. Please try again shortly.';
  }
  return err?.message || fallback;
}
