"use client";

/**
 * Whole lists. The API answers at most 200 items per page (`{items, next_cursor}`); the account's own lists (apps,
 * proofs, sessions, Silicons, custodian requests, owned apps) are read to their end, so a count or a filter on a page
 * is never computed from the first 200 alone (a review finding: "Active (200)" from one request).
 *
 * The answer keeps the shape of one page, so every cache writer that edits `items` keeps working: `next_cursor` is null
 * when every item is there, and the cursor to go on from when the guard below stopped the read.
 */
import { useQuery, type QueryKey } from "@tanstack/react-query";
import type { ApiError } from "../api/errors";
import type { Page, PageQuery } from "../api/types";

/** The API's largest page. */
export const PAGE_LIMIT = 200;
/**
 * A guard against a runaway list: 25 pages of 200 (5,000 items). A longer list keeps its `next_cursor`, and the page
 * that shows it says so (and names the CLI command that lists everything).
 */
export const MAX_LIST_PAGES = 25;

/** Reads a list to its end, following `next_cursor`, up to MAX_LIST_PAGES pages. */
export async function readEveryPage<T>(fetchPage: (query: PageQuery) => Promise<Page<T>>): Promise<Page<T>> {
  const items: T[] = [];
  let cursor: string | null = null;
  for (let read = 0; read < MAX_LIST_PAGES; read += 1) {
    const page: Page<T> = await fetchPage({ limit: PAGE_LIMIT, cursor });
    items.push(...page.items);
    if (!page.next_cursor) return { items, next_cursor: null };
    cursor = page.next_cursor;
  }
  return { items, next_cursor: cursor };
}

/** useQuery over a whole list (every page), cached under `queryKey` in the shape of one page. */
export function useWholeList<T>(queryKey: QueryKey, fetchPage: (query: PageQuery) => Promise<Page<T>>, enabled: boolean) {
  return useQuery<Page<T>, ApiError>({
    queryKey,
    queryFn: () => readEveryPage(fetchPage),
    enabled,
  });
}
