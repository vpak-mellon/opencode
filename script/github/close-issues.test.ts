// Requires close-issues.ts to:
//   1. export `main` (currently a private function)
//   2. guard its self-invocation with `if (import.meta.main) { main()... }`
//      so importing this file for testing doesn't immediately fire a real
//      main() against the real GitHub API.
//
// `close` and `shouldSkip` stay private — their effects are observed here
// by inspecting which URLs/methods the faked `fetch` receives.

import { describe, test, expect } from "bun:test"

// Module-level env checks run at import time, so these must be set first.
process.env.GITHUB_REPOSITORY = "owner/repo"
process.env.GITHUB_TOKEN = "test-token"

// Dynamic import (rather than a static one) so the env vars above are
// guaranteed to run first — static imports get hoisted ahead of other
// top-level code in the same module.
const { main } = await import("./close-issues")

type Issue = {
  number: number
  updated_at: string
  author_association: string
  user: { login: string } | null
}

function makeIssue(number: number, daysOld: number, overrides: Partial<Issue> = {}): Issue {
  return {
    number,
    updated_at: new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString(),
    author_association: "NONE",
    user: { login: "someone" },
    ...overrides,
  }
}

// cutoff is 60 days, computed from Date.now() inside the module — these
// helpers just need to land clearly on either side of that.
const STALE_DAYS = 90
const FRESH_DAYS = 5

function installFakeFetch(pages: Issue[][], opts: { listOk?: boolean; commentOk?: boolean } = {}) {
  const { listOk = true, commentOk = true } = opts
  let page = 0
  const commented: number[] = []
  const closed: number[] = []

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"

    if (method === "GET") {
      if (!listOk) return new Response("nope", { status: 500, statusText: "Server Error" })
      const body = pages[page] ?? []
      page++
      return new Response(JSON.stringify(body), { status: 200 })
    }

    if (method === "POST") {
      const match = String(url).match(/\/issues\/(\d+)\/comments$/)
      if (match) commented.push(Number(match[1]))
      if (!commentOk) return new Response("nope", { status: 500, statusText: "Server Error" })
      return new Response("{}", { status: 201 })
    }

    if (method === "PATCH") {
      const match = String(url).match(/\/issues\/(\d+)$/)
      if (match) closed.push(Number(match[1]))
      return new Response("{}", { status: 200 })
    }

    throw new Error(`Unexpected fetch call: ${method} ${url}`)
  }) as typeof fetch

  return { commented, closed }
}

describe("main", () => {
  test("closes issues older than the cutoff and stops at the first fresh one", async () => {
    const { closed } = installFakeFetch([
      [
        makeIssue(1, STALE_DAYS), // stale -> closed
        makeIssue(2, STALE_DAYS), // stale -> closed
        makeIssue(3, FRESH_DAYS), // fresh -> stop here
        makeIssue(4, FRESH_DAYS), // never reached
      ],
    ])

    await main()

    expect(closed).toEqual([1, 2])
  })

  test("skips a stale issue authored by the exempt bot account", async () => {
    const { closed } = installFakeFetch([
      [
        makeIssue(10, STALE_DAYS, { user: { login: "opencode-agent[bot]" } }),
        makeIssue(11, FRESH_DAYS), // fresh -> stop
      ],
    ])

    await main()

    expect(closed).toEqual([])
  })

  test("skips a stale issue from an OWNER/MEMBER author association", async () => {
    const { closed } = installFakeFetch([
      [
        makeIssue(20, STALE_DAYS, { author_association: "OWNER" }),
        makeIssue(21, FRESH_DAYS), // fresh -> stop
      ],
    ])

    await main()

    expect(closed).toEqual([])
  })

  test("paginates while every issue on the page is stale", async () => {
    const page1 = Array.from({ length: 100 }, (_, k) => makeIssue(k + 1, STALE_DAYS))
    const page2 = [makeIssue(200, FRESH_DAYS)] // fresh -> stop
    const { closed } = installFakeFetch([page1, page2])

    await main()

    expect(closed.length).toBe(100)
  })

  test("throws when the issues list request is not ok", async () => {
    installFakeFetch([[makeIssue(1, STALE_DAYS)]], { listOk: false })

    await expect(main()).rejects.toThrow()
  })

  test("propagates an error when closing an issue fails", async () => {
    installFakeFetch([[makeIssue(1, STALE_DAYS)]], { commentOk: false })

    await expect(main()).rejects.toThrow()
  })
})