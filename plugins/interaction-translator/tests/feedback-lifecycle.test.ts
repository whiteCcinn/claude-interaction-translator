import { expect, test } from "claude-code/testing"
import type { EngineInterface, Timer } from "claude-code"
import { clearFeedback, startFeedback, finishFeedback } from "../hooks/translation-feedback"
import type { FeedbackState } from "../hooks/translation-feedback"

test("cancelling feedback clears the owned card and stops all future refreshes", async () => {
  const state: FeedbackState = { interactive: true }
  const cancellation = new AbortController()
  let redraws = 0
  let cancelled = false
  let refresh: (() => void | Promise<void>) | undefined
  const engine = {
    ui: { invalidate() { redraws += 1 } },
    clock: {
      now: () => Promise.resolve(500),
      every: (_: number, callback: () => void | Promise<void>) => {
        refresh = callback
        return { cancel() { cancelled = true } } as Timer
      },
    },
  } as unknown as EngineInterface
  const handle = await startFeedback(engine, state, "output", "en", "cn", cancellation.signal)
  if (!refresh) throw new Error("No refresh timer started")
  await refresh()
  expect(state.current?.phase).toBe("loading")
  cancellation.abort()
  expect(state.current).toBe(undefined)
  expect(cancelled).toBe(true)
  const afterCancellation = redraws
  await refresh()
  await finishFeedback(engine, state, handle, true)
  expect(state.current).toBe(undefined)
  expect(redraws).toBe(afterCancellation)
})

test("an old completion waiting for the clock cannot install a dismissal timer for a newer card", async () => {
  let release: ((value: number) => void) | undefined
  let delayed = false
  let dismissalTimers = 0
  const state: FeedbackState = { interactive: true }
  const engine = {
    ui: { invalidate() {} },
    clock: {
      now: () => delayed ? new Promise<number>(resolve => { release = resolve }) : Promise.resolve(0),
      every: () => ({ cancel() {} }) as Timer,
      after: () => { dismissalTimers += 1; return { cancel() {} } as Timer },
    },
  } as unknown as EngineInterface
  const signal = new AbortController().signal
  const first = await startFeedback(engine, state, "input", "cn", "en", signal)
  delayed = true
  const finishing = finishFeedback(engine, state, first, true)
  const resume = release
  delayed = false
  const second = await startFeedback(engine, state, "output", "en", "cn", signal)
  if (!resume) throw new Error("The first completion did not wait for the clock")
  resume(500)
  await finishing
  expect(state.current).toBe(second)
  expect(state.current?.phase).toBe("loading")
  expect(dismissalTimers).toBe(0)
  clearFeedback(engine, state)
})

test("a cancelled start waiting for the clock cannot revive feedback or start a refresh timer", async () => {
  const state: FeedbackState = { interactive: true }
  const cancellation = new AbortController()
  let release: ((value: number) => void) | undefined
  let timers = 0
  const engine = {
    ui: { invalidate() {} },
    clock: {
      now: () => new Promise<number>(resolve => { release = resolve }),
      every: () => { timers += 1; return { cancel() {} } as Timer },
    },
  } as unknown as EngineInterface
  const starting = startFeedback(engine, state, "output", "en", "cn", cancellation.signal)
  cancellation.abort()
  if (!release) throw new Error("The start did not wait for the clock")
  release(0)
  await starting
  expect(state.current).toBe(undefined)
  expect(timers).toBe(0)
})

for (const succeeded of [true, false]) {
  test(`cancellation also clears a ${succeeded ? "completed" : "failed"} card and its dismissal timer`, async () => {
    const state: FeedbackState = { interactive: true }
    const cancellation = new AbortController()
    let hideCancelled = false
    const engine = {
      ui: { invalidate() {} },
      clock: {
        now: () => Promise.resolve(0),
        every: () => ({ cancel() {} }) as Timer,
        after: () => ({ cancel() { hideCancelled = true } }) as Timer,
      },
    } as unknown as EngineInterface
    const handle = await startFeedback(engine, state, "output", "en", "cn", cancellation.signal)
    await finishFeedback(engine, state, handle, succeeded)
    expect(state.current?.phase).toBe(succeeded ? "done" : "error")
    cancellation.abort()
    expect(state.current).toBe(undefined)
    expect(state.hideTimer).toBe(undefined)
    if (succeeded) expect(hideCancelled).toBe(true)
  })
}

for (const waitingForClock of [true, false]) {
  test(`a stale refresh ${waitingForClock ? "waiting for the clock" : "already queued"} cannot detach a completed card's cancellation`, async () => {
    const state: FeedbackState = { interactive: true }
    const cancellation = new AbortController()
    let refresh: (() => void | Promise<void>) | undefined
    let release: ((value: number) => void) | undefined
    let delayNextClock = false
    let hideCancelled = false
    const engine = {
      ui: { invalidate() {} },
      clock: {
        now: () => {
          if (!delayNextClock) return Promise.resolve(0)
          delayNextClock = false
          return new Promise<number>(resolve => { release = resolve })
        },
        every: (_: number, callback: () => void | Promise<void>) => {
          refresh = callback
          return { cancel() {} } as Timer
        },
        after: () => ({ cancel() { hideCancelled = true } }) as Timer,
      },
    } as unknown as EngineInterface
    const handle = await startFeedback(engine, state, "output", "en", "cn", cancellation.signal)
    if (!refresh) throw new Error("No refresh timer started")
    let refreshing: void | Promise<void> = undefined
    if (waitingForClock) {
      delayNextClock = true
      refreshing = refresh()
    }
    await finishFeedback(engine, state, handle, true)
    if (waitingForClock) {
      if (!release) throw new Error("Refresh did not wait for the clock")
      release(500)
      await refreshing
    } else await refresh()
    cancellation.abort()
    expect(state.current).toBe(undefined)
    expect(hideCancelled).toBe(true)
  })
}
