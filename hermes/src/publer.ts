/**
 * publer.ts — thin bridge to the pipeline's dependency-light Publer client
 * (tools/post-to-publer.ts). We re-export ONLY read + create-draft primitives.
 * We deliberately DO NOT re-export schedulePost / deletePost(s) / updatePost so
 * the loop physically cannot go live or mutate existing posts. See guardrails.ts.
 */
import "./config.ts"; // side-effect: load env before any Publer call

export {
  listAccounts,
  listPosts,
  getPostInsights,
  flattenPostInsights,
  importMediaFromUrl,
  createPost,
  pollJob,
  getJobStatus,
  type CreatePostArgs,
  type FlatPostInsight,
  type PostInsightsParams,
} from "../../tools/post-to-publer.ts";

import { listPosts } from "../../tools/post-to-publer.ts";

/** Page through a given state and return all posts (bounded). */
export async function listAllPosts(state: string, maxPages = 30): Promise<any[]> {
  const out: any[] = [];
  for (let page = 0; page < maxPages; page++) {
    const posts = await listPosts({ state, page });
    if (!posts.length) break;
    out.push(...posts);
    if (posts.length < 10) break; // last page (Publer pages are ~10)
  }
  return out;
}

export function postId(p: any): string {
  return String(p?.id ?? p?._id ?? "");
}
