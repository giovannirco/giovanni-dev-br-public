export function createModelPicker({ focusComposer }) {
  const $ = (selector) => document.querySelector(selector);
  const toggle = $("#model-toggle"),
    picker = $("#model-picker"),
    search = $("#model-search"),
    options = $("#model-options"),
    status = $("#model-status");
  let models = [],
    selected = "",
    loading = false,
    loadedAt = 0,
    error = false,
    active = 0;
  const filtered = () =>
    models.filter((m) =>
      `${m.name} ${m.id}`
        .toLowerCase()
        .includes(search.value.trim().toLowerCase()),
    );
  function close(restore = false) {
    picker.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    search.removeAttribute("aria-activedescendant");
    if (restore) toggle.focus();
  }
  function choose(model) {
    selected = model.id;
    $("#model-name").textContent = model.name;
    close();
    focusComposer();
  }
  function highlight() {
    const nodes = [...options.children];
    nodes.forEach((node, i) => node.classList.toggle("active", i === active));
    if (nodes[active]) {
      search.setAttribute("aria-activedescendant", nodes[active].id);
      nodes[active].scrollIntoView({ block: "nearest" });
    } else search.removeAttribute("aria-activedescendant");
  }
  function render() {
    const matches = filtered();
    options.replaceChildren();
    matches.forEach((model, i) => {
      const option = document.createElement("button");
      option.type = "button";
      option.id = `model-option-${i}`;
      option.role = "option";
      option.tabIndex = -1;
      option.setAttribute("aria-selected", String(model.id === selected));
      option.textContent = model.name;
      option.title = model.id;
      option.addEventListener("click", () => choose(model));
      options.append(option);
    });
    active = Math.min(active, Math.max(0, matches.length - 1));
    status.textContent = loading
      ? "Loading available models…"
      : error
        ? "Model list unavailable. You can still try the service default."
        : !models.length
          ? "No models reported by the service."
          : !matches.length
            ? "No matching models."
            : `${matches.length} ${matches.length === 1 ? "model" : "models"}`;
    $("#model-retry").hidden = !error;
    highlight();
  }
  async function load() {
    if (loading || Date.now() - loadedAt < 60_000) return;
    loading = true;
    error = false;
    render();
    try {
      const response = await fetch("/api/chat/models", {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("unavailable");
      const data = await response.json();
      if (!Array.isArray(data.models)) throw new Error("unavailable");
      models = data.models.filter(
        (m) => typeof m.id === "string" && typeof m.name === "string",
      );
      const choice =
        models.find((m) => m.id === selected) ||
        models.find((m) => m.id === data.defaultModel);
      selected = choice?.id || "";
      $("#model-name").textContent = choice?.name || "Service default";
      loadedAt = Date.now();
    } catch {
      error = true;
    } finally {
      loading = false;
      render();
    }
  }
  toggle.addEventListener("click", () => {
    if (!picker.hidden) {
      close(true);
      return;
    }
    picker.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    search.value = "";
    active = 0;
    render();
    search.focus();
    load();
  });
  $("#model-dismiss").addEventListener("click", () => close(true));
  search.addEventListener("input", () => {
    active = 0;
    render();
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const length = filtered().length;
      if (length)
        active =
          (active + (event.key === "ArrowDown" ? 1 : -1) + length) % length;
      highlight();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (filtered()[active]) choose(filtered()[active]);
    }
  });
  picker.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".comm-models")) close();
  });
  $("#model-retry").addEventListener("click", () => load());
  return {
    load,
    close,
    value: () => selected || undefined,
    name: () => (selected ? $("#model-name").textContent : ""),
    setBusy(busy) {
      toggle.disabled = busy;
      if (busy) close();
    },
  };
}
