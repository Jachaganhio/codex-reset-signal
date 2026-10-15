// One-time, read-only source discovery and explicit state migration. No sends.
import { readFile } from "node:fs/promises";
import { FxEmbedClient } from "../../src/fxembed-client";
import { extractPostEvents } from "../../src/reply-events";
import { emptyState, writeState } from "../../src/state";
import { postVersion } from "../../src/monitor";
import { DateTime } from "luxon";
const [oldPath,newPath]=process.argv.slice(2);
if (!oldPath || !newPath) throw new Error("Provide old Python state and new state paths");
try { await readFile(newPath); throw new Error("Destination already exists"); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const old=JSON.parse(await readFile(oldPath,"utf8"));
if (!old.initialized || !old.seen || typeof old.seen !== "object") throw new Error("Invalid legacy state");
const source=new FxEmbedClient();
const userId=await source.resolveUserId("thsottiaux");
const fetched=await source.getPosts({userId,username:"thsottiaux",bootstrap:true});
if (!fetched.posts.length) throw new Error("No authored timeline to migrate");
const cutoff=DateTime.now().setZone("Asia/Shanghai").startOf("day").toMillis();
const today=fetched.posts.filter(p=>p.createdAt && Date.parse(p.createdAt)>=cutoff);
const state=emptyState("thsottiaux","reset");
state.userId=userId;
for (const [key,value] of Object.entries(old.seen)) {
  const id=key.split(":")[0];
  if (/^\d+$/.test(id)) state.seen![id]="legacy:"+String(value);
}
for (const post of fetched.posts) {
  if (Object.hasOwn(state.seen!,post.id) || !post.createdAt || Date.parse(post.createdAt)<cutoff)
    state.seen![post.id]=postVersion(post);
}
const eligibleIds=today.filter(p=>state.seen![p.id]!==postVersion(p)).map(p=>BigInt(p.id));
state.sinceId=eligibleIds.length
  ? (eligibleIds.reduce((a,b)=>a<b?a:b)-1n).toString()
  : fetched.newestId;
state.lastRunStatus="migrated-awaiting-first-collection";
await writeState(newPath,state);
const planned=today.filter(p=>state.seen![p.id]!==postVersion(p) && extractPostEvents(p).length);
console.log(JSON.stringify({migratedLegacyIds:Object.keys(old.seen).length,
  cutoff:DateTime.fromMillis(cutoff).toISO(),sinceId:state.sinceId,
  catchup:planned.map(p=>({id:p.id,text:p.text,url:p.url}))},null,2));
