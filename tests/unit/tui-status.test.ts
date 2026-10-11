import { describe, expect, test } from "bun:test"
import { formatCount, statusText } from "../../tui/status.ts"

describe("formatCount", () => {
  test("small counts keep their separators", () => {
    expect(formatCount(861)).toBe("861")
    expect(formatCount(9999)).toBe("9,999")
  })

  test("compact units kick in at 10k", () => {
    expect(formatCount(12_273)).toBe("12.3k")
    expect(formatCount(24_371_828)).toBe("24.4M")
    expect(formatCount(1_600_000_000)).toBe("1.6B")
  })

  test("non-finite input is stringified, never crashed on", () => {
    expect(formatCount(Number.NaN)).toBe("NaN")
  })
})

describe("statusText", () => {
  test("no data means no indicator, not a misleading zero", () => {
    expect(statusText(undefined)).toBeUndefined()
  })

  test("a real zero is shown", () => {
    expect(statusText(0)).toBe("cg cache read 0")
  })

  test("cumulative read is labelled as cache read", () => {
    expect(statusText(24_371_828)).toBe("cg cache read 24.4M")
  })
})
