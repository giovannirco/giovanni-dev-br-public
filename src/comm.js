import { marked } from "marked";
import DOMPurify from "dompurify";
import { createModelPicker } from "./model-picker.js";

function markdown(text) {
  return DOMPurify.sanitize(marked.parse(text, { breaks: true, gfm: true }), {
    ALLOWED_TAGS: [
      "p",
      "br",
      "strong",
      "em",
      "s",
      "ul",
      "ol",
      "li",
      "blockquote",
      "pre",
      "code",
      "a",
      "h2",
      "h3",
      "h4",
      "hr",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
    ],
    ALLOWED_ATTR: ["href", "title"],
    ALLOW_DATA_ATTR: false,
  });
}

export function createComm({ visitor, open, close, onOpen }) {
  const $ = (selector) => document.querySelector(selector);
  const panel = $("#comm-hud"),
    log = $("#comm-log"),
    input = $("#comm-input");
  function fitViewport() {
    if (!panel.open) return;
    const viewport = window.visualViewport;
    const height = viewport?.height || innerHeight;
    const keyboard = height < innerHeight - 120 && panel.contains(document.activeElement);
    const inset = keyboard ? 8 : Math.max(220, height * 0.26);
    panel.style.setProperty("--comm-top", `${(viewport?.offsetTop || 0) + inset}px`);
    panel.style.setProperty("--comm-height", `${Math.max(160, height - inset - 12)}px`);
    panel.classList.toggle("comm-keyboard", keyboard);
  }
  window.visualViewport?.addEventListener("resize", fitViewport);
  window.visualViewport?.addEventListener("scroll", fitViewport);
  window.addEventListener("resize", fitViewport);
  panel.addEventListener("focusin", fitViewport);
  panel.addEventListener("focusout", () => requestAnimationFrame(fitViewport));
  const models = createModelPicker({ focusComposer: () => input.focus() });
  const threads = new Map();
  let scope = null,
    request = null,
    follow = true;
  const current = () => scope && threads.get(scope.id);
  function scroll() {
    if (follow) {
      log.scrollTop = log.scrollHeight;
      $("#comm-latest").hidden = true;
    } else $("#comm-latest").hidden = false;
  }
  function controls() {
    models.setBusy(!!request);
    $("#comm-send").disabled = !!request || !input.value.trim();
    $("#comm-send").hidden = !!request;
    $("#comm-stop").hidden = !request;
    $("#comm-clear").disabled = !!request || !current()?.messages.length;
    input.setAttribute("aria-busy", String(!!request));
  }
  function render() {
    const thread = current();
    if (!thread) return;
    const scrollTop = log.scrollTop;
    log.replaceChildren();
    if (!thread.messages.length) {
      const intro = document.createElement("div");
      intro.className = "comm-starters";
      const heading = document.createElement("h3");
      heading.textContent = `Ask about ${scope.name}`;
      const context = document.createElement("p");
      context.textContent = scope.parent
        ? "Questions here stay with this moon."
        : "Questions here cover this planet and its moons.";
      intro.append(heading, context);
      for (const prompt of scope.prompts || ["What do you work on here?"]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = prompt;
        button.addEventListener("click", () => {
          input.value = prompt;
          controls();
          input.focus();
        });
        intro.append(button);
      }
      log.append(intro);
    }
    for (const message of thread.messages) {
      const row = document.createElement("article");
      row.className = `comm-message ${message.role}`;
      const label = document.createElement("span");
      label.className = "comm-author";
      label.textContent =
        message.role === "user"
          ? "YOU"
          : `ORBIT ASSISTANT${message.modelName ? " · " + message.modelName : ""}`;
      const body = document.createElement("div");
      body.className = "comm-markdown";
      if (message.role === "user") body.textContent = message.content;
      else {
        body.innerHTML = markdown(message.content);
        body.querySelectorAll("a").forEach((a) => {
          const href = a.getAttribute("href") || "";
          if (!/^(https?:\/\/|mailto:)/i.test(href)) a.removeAttribute("href");
          else {
            a.target = "_blank";
            a.rel = "noopener noreferrer";
          }
        });
      }
      row.append(label, body);
      if (message.state === "waiting" && !message.content) {
        const pending = document.createElement("p");
        pending.className = "comm-thinking";
        pending.textContent = "Reading the orbit notes…";
        row.append(pending);
      }
      if (message.state === "stopped" || message.state === "error") {
        const note = document.createElement("p");
        note.className = "comm-message-state";
        note.textContent =
          message.state === "stopped"
            ? "Response stopped."
            : "Could not get a response.";
        row.append(note);
        const retry = document.createElement("button");
        retry.className = "comm-retry";
        retry.textContent = "Try again";
        retry.addEventListener("click", () => {
          input.value = message.prompt;
          controls();
          input.focus();
        });
        row.append(retry);
      }
      log.append(row);
    }
    if (!follow) log.scrollTop = scrollTop;
    scroll();
    controls();
  }
  function stop() {
    if (!request) return;
    const old = request;
    request = null;
    old.controller.abort();
    old.message.state = "stopped";
    if (scope?.id === old.scopeId) {
      $("#comm-status").textContent =
        "Response stopped. You can send another message.";
      render();
    }
  }
  async function send() {
    const prompt = input.value.trim();
    if (!prompt || !scope || request) return;
    const thread = current(),
      scopeId = scope.id;
    const history = [];
    for (let i = 0; i < thread.messages.length - 1; i++) {
      if (
        thread.messages[i].role === "user" &&
        thread.messages[i + 1].role === "assistant" &&
        thread.messages[i + 1].state === "done"
      ) {
        history.push(
          ...thread.messages
            .slice(i, i + 2)
            .map(({ role, content }) => ({ role, content })),
        );
      }
    }
    const message = {
      role: "assistant",
      modelName: models.name(),
      content: "",
      state: "waiting",
      prompt,
    };
    thread.messages.push({ role: "user", content: prompt }, message);
    input.value = "";
    thread.draft = "";
    follow = true;
    const controller = new AbortController();
    const active = { controller, message, scopeId };
    request = active;
    const timer = setTimeout(() => controller.abort("timeout"), 50_000);
    $("#comm-status").textContent = "Waiting for a response…";
    render();
    input.focus();
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          visitor,
          bodyId: scopeId,
          model: models.value(),
          prompt,
          history: history.slice(-8),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(
          data.code === "model_unavailable"
            ? "model_unavailable"
            : "unavailable",
        );
      }
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        const reader = response.body.getReader(),
          decoder = new TextDecoder();
        let buffer = "";
        const event = (chunk) => {
          const lines = chunk.split("\n");
          const type = lines
            .find((l) => l.startsWith("event:"))
            ?.slice(6)
            .trim();
          const raw = lines
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          if (!raw) return;
          const data = JSON.parse(raw);
          if (type === "error") throw new Error("unavailable");
          if (type === "delta" && typeof data.text === "string")
            message.content += data.text;
        };
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder
            .decode(value, { stream: true })
            .replace(/\r\n/g, "\n");
          let end;
          while ((end = buffer.indexOf("\n\n")) !== -1) {
            event(buffer.slice(0, end));
            buffer = buffer.slice(end + 2);
          }
          if (request !== active || scope?.id !== scopeId) return;
          $("#comm-status").textContent = "Receiving response…";
          render();
        }
        if (buffer.trim()) event(buffer);
      } else {
        const data = await response.json();
        if (typeof data.content !== "string") throw new Error("empty");
        message.content = data.content;
      }
      if (request !== active || scope?.id !== scopeId) return;
      if (!message.content.trim()) throw new Error("empty");
      message.state = "done";
      $("#comm-status").textContent =
        `About ${scope.name} · answers use this orbit’s notes.`;
    } catch (error) {
      if (request !== active || scope?.id !== scopeId) return;
      message.state = "error";
      $("#comm-status").textContent =
        error.message === "model_unavailable"
          ? "That model is unavailable. Choose another model and retry."
          : "COMM is unavailable. Try again, or read the notes.";
    } finally {
      clearTimeout(timer);
      if (request === active) {
        request = null;
        render();
      }
    }
  }
  $("#comm-form").addEventListener("submit", (e) => {
    e.preventDefault();
    send();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  input.addEventListener("input", () => {
    if (current()) current().draft = input.value;
    controls();
  });
  $("#comm-stop").addEventListener("click", stop);
  $("#comm-clear").addEventListener("click", () => {
    stop();
    current().messages = [];
    follow = true;
    render();
    $("#comm-status").textContent = "Chat cleared for this orbit.";
    input.focus();
  });
  $("#comm-toggle").addEventListener("click", () => {
    if (!scope) return;
    if (panel.open) {
      close();
      return;
    }
    open();
    onOpen?.(scope);
    models.load();
    $("#comm-toggle").setAttribute("aria-expanded", "true");
    document.body.classList.add("comm-open");
    follow = true;
    render();
    fitViewport();
    if (!matchMedia("(pointer: coarse)").matches) input.focus();
  });
  panel.addEventListener("close", () => {
    models.close();
    stop();
    $("#comm-toggle").setAttribute("aria-expanded", "false");
    document.body.classList.remove("comm-open");
  });
  panel.addEventListener("cancel", (e) => e.stopPropagation());
  log.addEventListener("scroll", () => {
    follow = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
    $("#comm-latest").hidden = follow;
  });
  $("#comm-latest").addEventListener("click", () => {
    follow = true;
    scroll();
  });
  return {
    setScope(next) {
      if (scope?.id === next?.id) return;
      stop();
      if (panel.open) close();
      scope = next;
      if (!scope) return;
      if (!threads.has(scope.id))
        threads.set(scope.id, { messages: [], draft: "" });
      input.value = current().draft;
      $("#comm-title").textContent = scope.name;
      $("#comm-scope").textContent = scope.parent
        ? `${scope.sector} / ${scope.name}`
        : scope.name;
      input.placeholder = `Ask about ${scope.name}…`;
      $("#comm-status").textContent = "Answers use the notes for this orbit.";
      follow = true;
      render();
    },
  };
}
