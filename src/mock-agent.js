import { EventEmitter } from "node:events";

/** Emits the same event shapes as Pi RPC, for UI work without a model login. */
export class MockAgent extends EventEmitter {
  constructor() {
    super();
    this.alive = true;
  }

  start() {
    return this;
  }

  async getState() {
    return { sessionId: "mock", sessionFile: null, isStreaming: false };
  }

  async getStats() {
    return { tokens: { input: 1200, output: 300, total: 1500 }, cost: 0.002 };
  }

  async switchSession() {
    return {};
  }

  async prompt(message) {
    const text = String(message || "");
    const reply =
      "（mock）我收到了：" +
      text.slice(0, 120) +
      "\n\n这是模拟回复。设置 T3LITE_MOCK=0 并确保 `pi` 已登录后，就会调用真实 Pi。";
    this.emit("event", { type: "agent_start" });
    this.emit("event", { type: "turn_start" });
    this.emit("event", {
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    for (const ch of reply) {
      this.emit("event", {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: ch },
      });
      await new Promise((r) => setTimeout(r, 8));
    }
    this.emit("event", {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: reply }] },
    });
    this.emit("event", { type: "agent_end", messages: [] });
    this.emit("event", { type: "agent_settled", aborted: false });
    return { disposition: "started" };
  }

  async abort() {
    return {};
  }

  respondUi() {}

  stop() {}
}
