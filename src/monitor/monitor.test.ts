import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUpdates: vi.fn(),
  getForUser: vi.fn(),
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../api/api.js", () => ({
  getUpdates: mocks.getUpdates,
  classifyFetchError: () => ({ type: "network", description: "test error" }),
}));
vi.mock("../api/config-cache.js", () => ({
  WeixinConfigManager: class {
    getForUser(...args: unknown[]) {
      return mocks.getForUser(...args);
    }
  },
}));
vi.mock("../api/session-guard.js", () => ({
  STALE_TOKEN_ERRCODE: -14,
  pauseSession: vi.fn(),
  getRemainingPauseMs: () => 0,
}));
vi.mock("../messaging/process-message.js", () => ({ processOneMessage: vi.fn() }));
vi.mock("../storage/sync-buf.js", () => ({
  getSyncBufFilePath: () => "unused-sync-buffer",
  loadGetUpdatesBuf: () => undefined,
  saveGetUpdatesBuf: vi.fn(),
}));
vi.mock("../util/logger.js", () => ({ logger: { withAccount: () => mocks.log } }));

import { monitorWeixinProvider } from "./monitor.js";

describe("monitor connection status", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getForUser.mockResolvedValue({});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function start(controller: AbortController, setStatus = vi.fn()) {
    return {
      setStatus,
      done: monitorWeixinProvider({
        baseUrl: "https://example.invalid",
        cdnBaseUrl: "https://example.invalid",
        accountId: "test-account",
        config: {},
        channelRuntime: {} as never,
        abortSignal: controller.signal,
        setStatus,
      }),
    };
  }

  it("reports a successful poll as connected and clears it when aborted", async () => {
    const controller = new AbortController();
    mocks.getUpdates.mockResolvedValueOnce({ ret: 0, msgs: [] }).mockImplementationOnce(() => {
      controller.abort();
      throw new Error("aborted");
    });

    const { done, setStatus } = start(controller);
    await done;

    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "test-account",
        connected: true,
        lastConnectedAt: expect.any(Number),
        lastEventAt: expect.any(Number),
        lastError: null,
      }),
    );
    expect(setStatus).toHaveBeenLastCalledWith({ accountId: "test-account", connected: false });
  });

  it("clears a previous connection when the API returns an error", async () => {
    const controller = new AbortController();
    const setStatus = vi.fn();
    let statusBeforeRetry: unknown;
    mocks.getUpdates
      .mockResolvedValueOnce({ ret: 0, msgs: [] })
      .mockResolvedValueOnce({ ret: -2, errmsg: "test error" })
      .mockImplementationOnce(() => {
        statusBeforeRetry = setStatus.mock.lastCall?.[0];
        controller.abort();
        throw new Error("aborted");
      });

    const { done } = start(controller, setStatus);
    await vi.advanceTimersByTimeAsync(2000);
    await done;

    expect(statusBeforeRetry).toEqual(
      expect.objectContaining({
        accountId: "test-account",
        connected: false,
      }),
    );
  });

  it("does not report a connection when stopped before the first poll", async () => {
    const controller = new AbortController();
    controller.abort();

    const { done, setStatus } = start(controller);
    await done;

    expect(mocks.getUpdates).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith({ accountId: "test-account", connected: false });
  });

  it("clears a previous connection when polling throws a network error", async () => {
    const controller = new AbortController();
    const setStatus = vi.fn();
    let statusBeforeRetry: unknown;
    mocks.getUpdates
      .mockResolvedValueOnce({ ret: 0, msgs: [] })
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockImplementationOnce(() => {
        statusBeforeRetry = setStatus.mock.lastCall?.[0];
        controller.abort();
        throw new Error("aborted");
      });

    const { done } = start(controller, setStatus);
    await vi.advanceTimersByTimeAsync(2000);
    await done;

    expect(statusBeforeRetry).toEqual(
      expect.objectContaining({
        accountId: "test-account",
        connected: false,
      }),
    );
  });

  it("does not report an aborted poll's empty response as connected", async () => {
    const controller = new AbortController();
    mocks.getUpdates.mockImplementationOnce(async () => {
      controller.abort();
      return { ret: 0, msgs: [] };
    });

    const { done, setStatus } = start(controller);
    await done;

    expect(setStatus).toHaveBeenCalledWith({ accountId: "test-account", connected: false });
    expect(setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ connected: true }));
  });

  it("clears connection status when aborted during a message-processing retry", async () => {
    const controller = new AbortController();
    mocks.getUpdates.mockResolvedValueOnce({
      ret: 0,
      msgs: [{ from_user_id: "test@im.wechat" }],
    });
    mocks.getForUser.mockRejectedValueOnce(new Error("message configuration failed"));

    const { done, setStatus } = start(controller);
    const settled = done.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await settled;

    expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({ connected: true }));
    expect(setStatus).toHaveBeenLastCalledWith({ accountId: "test-account", connected: false });
  });
});
