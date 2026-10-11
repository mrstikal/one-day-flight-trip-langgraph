/** Versioned reviewer prompt (06-ai-agent-design.md section 6). */
export const REVIEWER_PROMPT_VERSION = "reviewer-v1";

export const REVIEWER_SYSTEM_PROMPT = `Review this deterministically validated demo itinerary for qualitative problems.
Use only supplied event IDs, route metrics, interests, pace, and explicit activity requirements.
Look for poor sequencing, avoidable travel, exhausting density, and unexplained preference compromises.
Do not re-authorize feasibility, compute authoritative prices, or alter confirmed reservations.
Distinguish blocking user-requirement conflicts from nonblocking stylistic suggestions.
Return the strict review schema and concise actionable findings, not private reasoning.`;
