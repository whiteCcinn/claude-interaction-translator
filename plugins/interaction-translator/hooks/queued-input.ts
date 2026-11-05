// Exact native 2.1.316/318 queued-command projection. Match the complete
// envelope, not an arbitrary occurrence of a pending prompt in context.
const PREFIX = "The user sent a new message while you were working:\n"
const SUFFIX = "\n\nThis is how Claude Code surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn."

export type QueuedInput = { source: string; prefix: string; suffix: string }

export function queuedInput(text: string): QueuedInput | undefined {
  const opening = /^<system-reminder(?: id="([0-9a-f]{16,32})")?>\n/.exec(text)
  if (!opening) return undefined
  const closing = opening[1] ? `\n</system-reminder id="${opening[1]}">` : "\n</system-reminder>"
  if (!text.endsWith(closing)) return undefined
  const inner = text.slice(opening[0].length, -closing.length)
  if (!inner.startsWith(PREFIX) || !inner.endsWith(SUFFIX)) return undefined
  return {
    source: inner.slice(PREFIX.length, -SUFFIX.length),
    prefix: opening[0] + PREFIX,
    suffix: SUFFIX + closing,
  }
}
