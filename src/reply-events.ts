import { extractEvents, parseEventTime, type ResetEvent } from "./events";
import type { XPost } from "./types";

/** Resolve only explicit timing replies to a verified same-author reset parent.
 * Keep the reply text untouched, and anchor relative time to the reply itself.
 */
export function extractPostEvents(post: XPost, timezone?: string): ResetEvent[] {
  const direct = extractEvents(post, timezone);
  if (direct.length) return direct;
  const parent = post.resetContext;
  if (!parent || parent.id !== post.replyToId ||
      !/\breset(?:s|ting)?\b/i.test(parent.text) || /\bbank(?:ed)?\b/i.test(parent.text) ||
      !/^(?:lands?|landing|scheduled|expected)\b/i.test(post.text.trim()) ||
      /\?|\b(?:not|never|maybe|might|could|if|hope)\b/i.test(post.text)) return [];
  const time = parseEventTime(post.text, post.createdAt, timezone);
  if (!["window", "exact", "date"].includes(time.kind)) return [];
  return [{ type: "reset", status: "scheduled", evidence: post.text, time }];
}
