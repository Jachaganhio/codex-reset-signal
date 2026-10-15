// Live, read-only source check. Never loads local notification credentials,
// creates state, sends a notification, or enables the paid provider.
import { loadConfig } from "../src/config";
import { FxEmbedClient } from "../src/fxembed-client";
import { extractPostEvents } from "../src/reply-events";
import { renderText } from "../src/notifications";

const config = loadConfig({ SOURCE_PROVIDER: "fxembed", X_USERNAME: "thsottiaux" });
const client = new FxEmbedClient();
const userId = await client.resolveUserId(config.username);
const result = await client.getPosts({ userId, username: config.username, bootstrap: true });
console.log(JSON.stringify({ source: "fxembed", fetchedAt: new Date().toISOString(),
  authoredPosts: result.posts.length, latestObservedPost: result.latestObservedPost?.id }));
for (const post of result.posts) {
  const events = extractPostEvents(post, config.sourceTimezone);
  if (events.length) console.log(renderText(post, events, config.timezone));
}
console.log("Read-only check complete: first page only; no state or notifications written.");
