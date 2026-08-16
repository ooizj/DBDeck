export function useAiSession() {
    const aiSessionId = `ai-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return { aiSessionId };
}
