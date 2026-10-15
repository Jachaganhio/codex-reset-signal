import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, validateConfig } from "../src/config";
import { createTargets } from "../src/notifications";
import { FxEmbedClient } from "../src/fxembed-client";
import { extractPostEvents } from "../src/reply-events";
import { runMonitor } from "../src/monitor";
import { emptyState, writeState } from "../src/state";
const dirs: string[] = [];
const fixture = JSON.parse(await readFile(new URL("../fixtures/tibo-20261015.json", import.meta.url), "utf8"));
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "tibo-bark-")); dirs.push(dir);
  const credentials = join(dir, "bark.json");
  await writeFile(credentials, JSON.stringify({ server: "https://api.day.app", device_key: "test-secret-key" }), { mode: 0o600 });
  const config = loadConfig({ BARK_CONFIG_PATH: credentials, STATE_PATH: join(dir, "state.json") });
  await writeState(config.statePath, { ...emptyState("thsottiaux", "reset"), userId: "1953337039510003712", sinceId: "2110595484180214058" });
  const sourceFetch = vi.fn(async () => Response.json(fixture));
  return { dir, credentials, config, sourceFetch, source: new FxEmbedClient(sourceFetch) };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe("R5S direct collection and Bark", () => {
  it("delivers the actual missed post and contextual timing reply, then deduplicates", async () => {
    const { config, source, sourceFetch } = await setup();
    expect(validateConfig(config)).toEqual([]);
    const notifyFetch = vi.fn(async () => Response.json({ code: 200 }));
    const targets = createTargets(config, notifyFetch);
    const deps = { source, targets };
    const result = await runMonitor(config, deps);
    expect(notifyFetch).toHaveBeenCalledTimes(2);
    const payloads = notifyFetch.mock.calls.map(call => JSON.parse((call as unknown as [unknown, RequestInit])[1].body as string));
    expect(payloads[0].url).toBe("https://x.com/thsottiaux/status/2110595484180214059");
    expect(payloads[1].url).toBe("https://x.com/thsottiaux/status/2110595554036400151");
    expect(payloads[1].body).toContain("14:56");
    expect(payloads[1].body).toContain("关联的本人原帖");
    expect(payloads[1].title).not.toContain("完成");
    expect(payloads[1].device_key).toBe("test-secret-key");
    expect(JSON.stringify(result)).not.toContain("test-secret-key");
    expect(JSON.stringify(sourceFetch.mock.calls)).not.toContain("test-secret-key");
    expect(result.outbox).toEqual([]);
    await runMonitor(config, deps);
    expect(notifyFetch).toHaveBeenCalledTimes(2);
  });
  it("retains rejected Bark deliveries and retries them during a collection outage", async () => {
    const { config, source, sourceFetch } = await setup();
    const notifyFetch = vi.fn(async () => Response.json({ code: 400, message: "do-not-log-test-secret-key" }));
    const deps = { source, targets: createTargets(config, notifyFetch) };
    await expect(runMonitor(config, deps)).rejects.toThrow("bark delivery failed");
    expect(JSON.parse(await readFile(config.statePath, "utf8")).outbox).toHaveLength(2);
    sourceFetch.mockRejectedValue(new Error("source unavailable"));
    notifyFetch.mockImplementation(async () => Response.json({ code: 200 }));
    await expect(runMonitor(config, deps)).rejects.toThrow("collection failed");
    expect(JSON.parse(await readFile(config.statePath, "utf8")).outbox).toEqual([]);
  });
  it("does not trust foreign context or unrelated timing replies", async () => {
    const { sourceFetch } = await setup();
    const foreign = structuredClone(fixture);
    foreign.results[0].author.id = "999";
    sourceFetch.mockImplementation(async () => Response.json(foreign));
    const fetched = await new FxEmbedClient(sourceFetch).getPosts({ userId: "1953337039510003712", username: "thsottiaux", bootstrap: true });
    expect(fetched.posts).toHaveLength(1);
    expect(extractPostEvents(fetched.posts[0])).toEqual([]);
    expect(extractPostEvents({ ...fetched.posts[0], text: "Maybe landing within two hours?" })).toEqual([]);
  });
  it("redacts bad credential files and rejects invalid Bark success responses", async () => {
    const { config, credentials, source } = await setup();
    await writeFile(credentials, '{"device_key":"test-secret-key"}');
    expect(() => loadConfig({ BARK_CONFIG_PATH: credentials })).toThrow("details withheld");
    const posts = await source.getPosts({ userId: "1953337039510003712", username: "thsottiaux", bootstrap: true });
    const target = createTargets(config, vi.fn(async () => new Response("invalid json")))[0];
    await expect(target.send({ key: "test", post: posts.posts[0], events: [], targets: [], delivered: [] })).rejects.toThrow("invalid JSON");
    const failing = createTargets(config, vi.fn(async () => { throw new Error("test-secret-key"); }))[0];
    await expect(failing.send({ key: "test", post: posts.posts[0], events: [], targets: [], delivered: [] })).rejects.toThrow(/^Notification request failed or timed out$/);
  });
});
