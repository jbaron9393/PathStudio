function sortExportCardsForAnki(cards) {
  const sortDetails = (card) => {
    const rawText = String(card?.text || "").trim();
    const startsWithCloze = /^\{\{c\d+::/i.test(rawText);
    const visibleText = rawText
      .replace(/<[^>]*>/g, " ")
      .replace(/\{\{c\d+::(.*?)(?:::[^}]*)?\}\}/gi, "$1")
      .replace(/\s+/g, " ")
      .trim();
    return { startsWithCloze, visibleText };
  };

  return [...cards].sort((a, b) => {
    const left = sortDetails(a);
    const right = sortDetails(b);
    if (left.startsWithCloze !== right.startsWithCloze) {
      return left.startsWithCloze ? 1 : -1;
    }
    const alphabetical = left.visibleText.localeCompare(right.visibleText, undefined, {
      sensitivity: "base",
      numeric: true,
    });
    return alphabetical || (Number(a.sourceOrder) || 0) - (Number(b.sourceOrder) || 0);
  });
}

function cleanExportTextForDisplay(text) {
  const decoder = document.createElement("textarea");
  decoder.innerHTML = String(text || "");
  let cleaned = decoder.value;
  decoder.innerHTML = cleaned;
  cleaned = decoder.value;

  // Some Anki fields contain serialized/escaped markup. Decode it for the
  // preview only; the original HTML remains untouched in the stored note.
  cleaned = cleaned
    .replace(/\\+(?=<\/?[a-z][^>]*>)/gi, "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:div|p|li|ul|ol|h[1-6]|table|tr)>/gi, "\n")
    .replace(/<(?:div|p|li|ul|ol|h[1-6]|table|tr)\b[^>]*>/gi, "\n")
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*?)?\s*\/?>/gi, "");

  decoder.innerHTML = cleaned;
  return decoder.value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

document.addEventListener("DOMContentLoaded", () => {
  // ============================
  // CLOZE REFINER TAB WIRING
  // ============================
  const bulkInput = document.getElementById("bulkInput");
  const outputs = document.getElementById("outputs");
  const emptyState = document.getElementById("emptyState");

  const statusEl = document.getElementById("status");
  const inputStats = document.getElementById("inputStats");

  const modelEl = document.getElementById("model");
  const tempEl = document.getElementById("temp");
  const autoInsertBtn = document.getElementById("autoInsert");

  const refineAllBtn = document.getElementById("refineAll");
  const clearBtn = document.getElementById("clear");
  const copyAllBtn = document.getElementById("copyAll");
  const downloadAllBtn = document.getElementById("downloadAll");

  const extraRulesEl = document.getElementById("extraRules"); // optional box
  const rfKeepRules = document.getElementById("rfKeepRules");
  const ruleSuggestions = document.getElementById("ruleSuggestions");
  const ruleSuggestionChips = document.getElementById("ruleSuggestionChips");

  // ---- hard fails (prevents "nothing happens") ----
  const required = [
    ["bulkInput", bulkInput],
    ["outputs", outputs],
    ["status", statusEl],
    ["inputStats", inputStats],
    ["model", modelEl],
    ["temp", tempEl],
    ["autoInsert", autoInsertBtn],
    ["refineAll", refineAllBtn],
    ["clear", clearBtn],
    ["copyAll", copyAllBtn],
    ["downloadAll", downloadAllBtn],
  ];
  const missing = required.filter(([, el]) => !el).map(([id]) => id);
  if (missing.length) {
    console.error("Missing required elements:", missing);
    alert("UI wiring error: missing element(s): " + missing.join(", "));
    return;
  }

  // ----- helpers -----
  function setStatus(text) {
    statusEl.innerHTML = `<span class="text-slate-600">${text || ""}</span>`;
  }

  function getDelimiter() {
    return "===CARD===";
  }

  function stripCodeFences(s) {
    return (s || "").replace(/```/g, "").trim();
  }

  function splitCards(text) {
    const d = getDelimiter();
    return stripCodeFences(text)
      .split(d)
      .map((x) => x.trim())
      .filter(Boolean);
  }

  function getClientDateContext() {
    const now = new Date();
    return {
      clientNowIso: now.toISOString(),
      clientNowLocal: now.toLocaleString(),
      clientTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    };
  }

  function refreshStats() {
    const n = splitCards(bulkInput.value).length;
    inputStats.textContent = `${n} card${n === 1 ? "" : "s"} detected`;
    refreshRuleSuggestions();
  }

  function suggestedRulesFor(text) {
    const value = String(text || "").trim();
    if (!value) return [];

    const suggestions = [];
    if (/\([^()]{2,}\)/.test(value)) {
      suggestions.push("Prioritize the high-yield concept inside parentheses when choosing each cloze anchor.");
      suggestions.push("Move supporting parenthetical detail outside the cloze so the tested answer stays succinct.");
    }
    if (value.split(/\s+/).length > 45) {
      suggestions.push("Keep only the minimum context needed to identify the answer; remove redundant wording.");
    }
    if (/\b(?:because|due to|caused by|associated with|characterized by)\b/i.test(value)) {
      suggestions.push("Prefer the diagnosis, mechanism, or hallmark finding over generic descriptive words.");
    }
    return suggestions.slice(0, 3);
  }

  function refreshRuleSuggestions() {
    if (!ruleSuggestions || !ruleSuggestionChips) return;
    const suggestions = suggestedRulesFor(bulkInput.value);
    ruleSuggestionChips.replaceChildren();
    ruleSuggestions.classList.toggle("hidden", suggestions.length === 0);

    suggestions.forEach((suggestion) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "text-left text-xs px-3 py-2 rounded-lg border border-primary-200 dark:border-primary-800 bg-primary-50 dark:bg-primary-950/40 text-primary-700 dark:text-primary-200 hover:bg-primary-100 dark:hover:bg-primary-900 transition-colors";
      button.textContent = `+ ${suggestion}`;
      button.addEventListener("click", () => {
        const current = extraRulesEl.value.trim();
        if (!current.includes(suggestion)) {
          extraRulesEl.value = [current, suggestion].filter(Boolean).join("\n");
        }
        extraRulesEl.focus();
      });
      ruleSuggestionChips.appendChild(button);
    });
  }

  function setActionsEnabled(on) {
    copyAllBtn.disabled = !on;
    downloadAllBtn.disabled = !on;
  }

  async function apiPostJson(url, payload, { timeoutMs = 30000, retryOn401 = true } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {}),
        signal: controller.signal,
      });

      const bodyText = await res.text();

      if (res.status === 401 && retryOn401) {
        await pingHealth({ silent: true });
        return apiPostJson(url, payload, { timeoutMs, retryOn401: false });
      }

      if (!res.ok) throw new Error(bodyText || `Request failed (${res.status})`);

      return bodyText ? JSON.parse(bodyText) : {};
    } catch (err) {
      if (err?.name === "AbortError") {
        throw new Error("Request timed out. If the app was idle, try again.");
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function pingHealth({ silent = false } = {}) {
    try {
      const res = await fetch("/health", {
        method: "GET",
        cache: "no-store",
        credentials: "include",
      });

      if (!res.ok && !silent) {
        setStatus("Connection check failed. Reload and sign in again.");
      }
    } catch (_err) {
      if (!silent) {
        setStatus("Connection lost. Ensure server.js is still running.");
      }
    }
  }

  // ----- render -----
  function renderCards(cards) {
    outputs.innerHTML = "";

    if (!cards.length) {
      if (emptyState) outputs.appendChild(emptyState);
      setActionsEnabled(false);
      return;
    }

    setActionsEnabled(true);

    cards.forEach((text, idx) => {
      const wrap = document.createElement("div");
      wrap.className = "bg-white border border-slate-200 rounded-xl p-3 shadow-sm";

      const top = document.createElement("div");
      top.className = "flex items-center justify-between mb-2";

      const tag = document.createElement("div");
      tag.className =
        "text-xs font-semibold px-2.5 py-1 rounded-full bg-primary-50 text-primary-700";
      tag.textContent = `Card ${idx + 1}`;

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className =
        "text-xs inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition-colors";
      copyBtn.textContent = "Copy";
      copyBtn.onclick = async () => {
        await navigator.clipboard.writeText(text);
        setStatus(`Copied Card ${idx + 1}`);
      };

      const pre = document.createElement("pre");
      pre.className =
        "whitespace-pre-wrap font-mono text-sm leading-relaxed text-slate-800";
      pre.dataset.cardOutput = text;
      appendSafeEmphasis(pre, text);

      top.appendChild(tag);
      top.appendChild(copyBtn);
      wrap.appendChild(top);
      wrap.appendChild(pre);
      outputs.appendChild(wrap);
    });
  }

  // Render only the small set of formatting tags supported by the refiner.
  // Everything else remains literal text, so model output cannot inject HTML.
  function appendSafeEmphasis(container, text) {
    const tagPattern = /<\/?(?:b|strong|i|em|u)>/gi;
    const stack = [container];
    let cursor = 0;

    for (const match of String(text || "").matchAll(tagPattern)) {
      stack.at(-1).append(document.createTextNode(text.slice(cursor, match.index)));
      const token = match[0];
      const closing = token.startsWith("</");
      const tag = token.match(/[a-z]+/i)[0].toLowerCase();

      if (closing) {
        if (stack.length > 1 && stack.at(-1).tagName.toLowerCase() === tag) {
          stack.pop();
        } else {
          stack.at(-1).append(document.createTextNode(token));
        }
      } else {
        const element = document.createElement(tag);
        stack.at(-1).append(element);
        stack.push(element);
      }
      cursor = match.index + token.length;
    }

    stack.at(-1).append(document.createTextNode(String(text || "").slice(cursor)));
  }

  // ----- actions -----
  async function refineAll() {
    const raw = bulkInput.value.trim();
    if (!raw) {
      setStatus("Paste cards first.");
      return;
    }

    refineAllBtn.disabled = true;
    setStatus("Refining cards…");

    try {
      const j = await apiPostJson("/api/refine", {
        text: raw,
        model: modelEl.value,
        temperature: Number(tempEl.value),
        delimiter: getDelimiter(),
        extraRules: extraRulesEl?.value || "",
        clientDateContext: getClientDateContext(),
      });
      const resultText = j.text ?? j.output ?? "";
      const cards = splitCards(resultText);

      renderCards(cards);
      setStatus(`Done — refined ${cards.length} card(s).`);
    } catch (err) {
      console.error(err);
      setStatus("Error: " + (err?.message || String(err)));
    } finally {
      refineAllBtn.disabled = false;
    }
  }

  function bindEnterSendCtrlNewline(textarea, onSend) {
    if (!textarea) return;

    textarea.addEventListener(
      "keydown",
      (e) => {
        const isEnter = e.key === "Enter" || e.key === "NumpadEnter";
        if (!isEnter) return;

        const isCmdOrCtrl = e.ctrlKey || e.metaKey;

        // Ctrl/Cmd + Enter → newline
        if (isCmdOrCtrl) {
          e.preventDefault();
          e.stopImmediatePropagation();
          e.stopPropagation();

          const start = textarea.selectionStart ?? textarea.value.length;
          const end = textarea.selectionEnd ?? textarea.value.length;

          textarea.value =
            textarea.value.slice(0, start) + "\n" + textarea.value.slice(end);

          textarea.selectionStart = textarea.selectionEnd = start + 1;
          return;
        }

        // Enter alone → send/refine
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        onSend();
      },
      true // capture
    );
  }

  // Apply to BOTH fields
  bindEnterSendCtrlNewline(bulkInput, refineAll);
  bindEnterSendCtrlNewline(extraRulesEl, refineAll);

  // ----- wire up events -----
  bulkInput.style.caretColor = "#0f172a";

  bulkInput.addEventListener("input", refreshStats);
  refreshStats();

  clearBtn.addEventListener("click", (e) => {
    e.preventDefault();
    bulkInput.value = "";
    const keepRefinerRules = rfKeepRules?.checked === true;
    if (extraRulesEl && !keepRefinerRules) extraRulesEl.value = "";
    renderCards([]);
    refreshStats();
    setStatus(keepRefinerRules ? "Cleared input and output. Kept extra rules." : "Cleared.");
    bulkInput.focus();
  });

  refineAllBtn.addEventListener("click", (e) => {
    e.preventDefault();
    refineAll();
  });

  autoInsertBtn.addEventListener("click", (e) => {
    e.preventDefault();

    const d = getDelimiter();
    const insert = `\n\n${d}\n\n`;

    const start = bulkInput.selectionStart ?? bulkInput.value.length;
    const end = bulkInput.selectionEnd ?? bulkInput.value.length;

    bulkInput.value =
      bulkInput.value.slice(0, start) + insert + bulkInput.value.slice(end);

    const pos = start + insert.length;
    bulkInput.focus();
    bulkInput.setSelectionRange(pos, pos);

    refreshStats();
  });

  copyAllBtn.addEventListener("click", async () => {
    const blocks = Array.from(outputs.querySelectorAll("[data-card-output]")).map(
      (p) => p.dataset.cardOutput || ""
    );
    if (!blocks.length) return setStatus("Nothing to copy.");

    const d = getDelimiter();
    await navigator.clipboard.writeText(blocks.join("\n\n" + d + "\n\n"));
    setStatus("Copied all cards.");
  });

  downloadAllBtn.addEventListener("click", () => {
    const blocks = Array.from(outputs.querySelectorAll("[data-card-output]")).map(
      (p) => p.dataset.cardOutput || ""
    );
    if (!blocks.length) return setStatus("Nothing to download.");

    const d = getDelimiter();
    const blob = new Blob([blocks.join("\n\n" + d + "\n\n")], {
      type: "text/plain",
    });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = "refined_cards.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();

    URL.revokeObjectURL(url);
    setStatus("Downloaded refined_cards.txt");
  });

  setActionsEnabled(false);
  setStatus("Ready to refine");

  // ============================
  // ANKI EXPORTS TAB WIRING
  // ============================
  const exportFile = document.getElementById("exportFile");
  const exportDropZone = document.getElementById("exportDropZone");
  const exportFileName = document.getElementById("exportFileName");
  const exportModel = document.getElementById("exportModel");
  const exportBatchSize = document.getElementById("exportBatchSize");
  const exportRules = document.getElementById("exportRules");
  const ankiSearchCue = document.getElementById("ankiSearchCue");
  const ankiSearchCueStatus = document.getElementById("ankiSearchCueStatus");
  const copyAnkiSearchCue = document.getElementById("copyAnkiSearchCue");
  const saveAnkiSearchCue = document.getElementById("saveAnkiSearchCue");
  const processExport = document.getElementById("processExport");
  const cancelExport = document.getElementById("cancelExport");
  const exportStatus = document.getElementById("exportStatus");
  const exportProgress = document.getElementById("exportProgress");
  const exportProgressTrack = document.getElementById("exportProgressTrack");
  const exportProgressLabel = document.getElementById("exportProgressLabel");
  const exportDetected = document.getElementById("exportDetected");
  const exportCompleted = document.getElementById("exportCompleted");
  const exportFailed = document.getElementById("exportFailed");
  const exportPreview = document.getElementById("exportPreview");
  const downloadExportApkg = document.getElementById("downloadExportApkg");
  const downloadExportTxt = document.getElementById("downloadExportTxt");
  const downloadExportDoc = document.getElementById("downloadExportDoc");

  let selectedExportFile = null;
  let refinedExportCards = [];
  let exportToken = "";
  let exportCancelled = false;
  const ANKI_SEARCH_CUE_STORAGE_KEY = "pathStudio.ankiSearchCue";

  try {
    const savedSearchCue = localStorage.getItem(ANKI_SEARCH_CUE_STORAGE_KEY);
    if (savedSearchCue !== null) ankiSearchCue.value = savedSearchCue;
  } catch (_error) {
    ankiSearchCueStatus.textContent = "Browser storage unavailable";
  }

  function setExportProgress(completed, total) {
    const percent = total ? Math.round((completed / total) * 100) : 0;
    exportProgress.style.width = `${percent}%`;
    exportProgressLabel.textContent = `${percent}%`;
    exportProgressTrack.setAttribute("aria-valuenow", String(percent));
  }

  function selectExportFile(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".apkg")) {
      exportStatus.textContent = "Please choose a file ending in .apkg.";
      return;
    }
    selectedExportFile = file;
    exportFileName.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
    exportStatus.textContent = "Deck ready to extract.";
    processExport.disabled = false;
    refinedExportCards = [];
    exportToken = "";
    downloadExportApkg.disabled = true;
    downloadExportTxt.disabled = true;
    downloadExportDoc.disabled = true;
  }

  function renderExportPreview(cards) {
    exportPreview.replaceChildren();
    const orderedCards = sortExportCardsForAnki(cards);
    orderedCards.slice(0, 100).forEach((card) => {
      const item = document.createElement("article");
      item.className = "rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 p-3";
      const displayText = cleanExportTextForDisplay(card.text);
      const actions = document.createElement("div");
      actions.className = "flex justify-end mt-2";
      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "inline-flex items-center gap-1 rounded-md bg-slate-200/80 dark:bg-slate-800 px-2 py-1 text-[11px] font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-700 transition";
      copyButton.textContent = "Copy";
      copyButton.setAttribute("aria-label", "Copy edited Anki card");
      copyButton.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(displayText);
          copyButton.textContent = "Copied";
          window.setTimeout(() => { copyButton.textContent = "Copy"; }, 1500);
        } catch (_error) {
          copyButton.textContent = "Copy failed";
          window.setTimeout(() => { copyButton.textContent = "Copy"; }, 1500);
        }
      });
      const content = document.createElement("div");
      content.className = "whitespace-pre-wrap text-sm text-slate-800 dark:text-slate-200 leading-relaxed";
      content.textContent = displayText;
      actions.append(copyButton);
      item.append(content, actions);
      exportPreview.appendChild(item);
    });
    if (orderedCards.length > 100) {
      const more = document.createElement("p");
      more.className = "text-center text-xs text-slate-500 py-2";
      more.textContent = `${orderedCards.length - 100} additional notes are included in the downloads.`;
      exportPreview.appendChild(more);
    }
  }

  function downloadExport(content, type, extension) {
    const baseName = (selectedExportFile?.name || "anki_export").replace(/\.apkg$/i, "");
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${baseName}_refined.${extension}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function exportAsText() {
    return sortExportCardsForAnki(refinedExportCards)
      .map((card, index) => `NOTE ${index + 1}\n${card.text}`)
      .join("\n\n===CARD===\n\n");
  }

  function escapeDocumentText(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function processAnkiExport() {
    if (!selectedExportFile) return;
    exportCancelled = false;
    refinedExportCards = [];
    processExport.disabled = true;
    cancelExport.classList.remove("hidden");
    downloadExportTxt.disabled = true;
    downloadExportDoc.disabled = true;
    downloadExportApkg.disabled = true;
    exportDetected.textContent = "0";
    exportCompleted.textContent = "0";
    exportFailed.textContent = "0";
    setExportProgress(0, 0);
    exportStatus.textContent = "Extracting notes from the Anki package…";

    try {
      const extractionResponse = await fetch("/api/exports/apkg", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-File-Name": encodeURIComponent(selectedExportFile.name),
        },
        body: selectedExportFile,
      });
      const responseText = await extractionResponse.text();
      if (!extractionResponse.ok) throw new Error(responseText || "Could not extract this deck.");
      const extracted = JSON.parse(responseText);
      exportToken = String(extracted.exportToken || "");
      const notes = Array.isArray(extracted.notes) ? extracted.notes : [];
      if (!notes.length) throw new Error("No editable note text was found in this deck.");

      exportDetected.textContent = String(notes.length);
      const batchSize = Number(exportBatchSize.value) || 10;
      let failures = 0;

      for (let start = 0; start < notes.length; start += batchSize) {
        if (exportCancelled) break;
        const batch = notes.slice(start, start + batchSize);
        exportStatus.textContent = `Refining notes ${start + 1}–${Math.min(start + batch.length, notes.length)} of ${notes.length}…`;
        try {
          const result = await apiPostJson(
            "/api/export-refine",
            {
              text: batch.map((note) => note.text).join("\n\n===CARD===\n\n"),
              model: exportModel.value,
              temperature: 0.2,
              delimiter: "===CARD===",
              extraRules: exportRules.value,
              clientDateContext: getClientDateContext(),
            },
            { timeoutMs: 120000 },
          );
          const outputs = Array.isArray(result.cards) ? result.cards : [];
          batch.forEach((note, index) => {
            const output = outputs[index]?.text;
            if (!output) failures += 1;
            refinedExportCards.push({
              ...note,
              originalText: note.text,
              text: output || note.text,
              warning: outputs[index]?.warning || "",
              failed: !output,
            });
          });
        } catch (error) {
          console.error("Export batch failed:", error);
          failures += batch.length;
          refinedExportCards.push(...batch.map((note) => ({
            ...note,
            originalText: note.text,
            text: note.text,
            failed: true,
          })));
        }

        exportCompleted.textContent = String(refinedExportCards.length - failures);
        exportFailed.textContent = String(failures);
        setExportProgress(refinedExportCards.length, notes.length);
        renderExportPreview(refinedExportCards);
      }

      if (exportCancelled) {
        exportStatus.textContent = `Stopped after ${refinedExportCards.length} of ${notes.length} notes.`;
      } else {
        exportStatus.textContent = failures
          ? `Finished. ${failures} note(s) kept their original text and need review.`
          : `Finished refining all ${notes.length} notes.`;
      }
      const hasResults = refinedExportCards.length > 0;
      downloadExportTxt.disabled = !hasResults;
      downloadExportDoc.disabled = !hasResults;
      downloadExportApkg.disabled = !hasResults || !exportToken || exportCancelled;
    } catch (error) {
      console.error(error);
      exportStatus.textContent = `Error: ${error?.message || error}`;
    } finally {
      processExport.disabled = false;
      cancelExport.classList.add("hidden");
    }
  }

  exportFile?.addEventListener("change", () => selectExportFile(exportFile.files?.[0]));
  ["dragenter", "dragover"].forEach((eventName) => exportDropZone?.addEventListener(eventName, (event) => {
    event.preventDefault();
    exportDropZone.classList.add("border-primary-600", "bg-primary-50");
  }));
  ["dragleave", "drop"].forEach((eventName) => exportDropZone?.addEventListener(eventName, (event) => {
    event.preventDefault();
    exportDropZone.classList.remove("border-primary-600", "bg-primary-50");
  }));
  exportDropZone?.addEventListener("drop", (event) => selectExportFile(event.dataTransfer?.files?.[0]));
  ankiSearchCue?.addEventListener("input", () => {
    ankiSearchCueStatus.textContent = "Unsaved changes";
  });
  saveAnkiSearchCue?.addEventListener("click", () => {
    try {
      localStorage.setItem(ANKI_SEARCH_CUE_STORAGE_KEY, ankiSearchCue.value);
      ankiSearchCueStatus.textContent = "Saved in this browser";
    } catch (_error) {
      ankiSearchCueStatus.textContent = "Could not save";
    }
  });
  copyAnkiSearchCue?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(ankiSearchCue.value);
      ankiSearchCueStatus.textContent = "Copied to clipboard";
    } catch (_error) {
      ankiSearchCue.select();
      const copied = document.execCommand("copy");
      ankiSearchCueStatus.textContent = copied ? "Copied to clipboard" : "Copy failed";
    }
  });
  processExport?.addEventListener("click", processAnkiExport);
  cancelExport?.addEventListener("click", () => {
    exportCancelled = true;
    exportStatus.textContent = "Stopping after the current batch…";
  });
  downloadExportTxt?.addEventListener("click", () => downloadExport(exportAsText(), "text/plain;charset=utf-8", "txt"));
  downloadExportApkg?.addEventListener("click", async () => {
    if (!exportToken || !refinedExportCards.length) return;
    downloadExportApkg.disabled = true;
    exportStatus.textContent = "Building edited Anki package…";
    try {
      const response = await fetch("/api/exports/apkg/rebuild", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exportToken,
          edits: refinedExportCards.map(({ noteId, editableFieldIndexes, text }) => ({ noteId, editableFieldIndexes, text })),
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") || "";
      const fileName = disposition.match(/filename="([^"]+)"/)?.[1] || "edited_deck.apkg";
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      exportToken = "";
      exportStatus.textContent = "Edited Anki package downloaded.";
    } catch (error) {
      exportStatus.textContent = `Package error: ${error?.message || error}`;
      downloadExportApkg.disabled = false;
    }
  });
  downloadExportDoc?.addEventListener("click", () => {
    const body = sortExportCardsForAnki(refinedExportCards).map((card, index) =>
      `<h2>Note ${index + 1}</h2><p>${escapeDocumentText(card.text).replace(/\n/g, "<br>")}</p>`,
    ).join("<hr>");
    const documentHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Refined Anki Notes</title><style>body{font-family:Calibri,Arial,sans-serif;line-height:1.5;margin:40px}h1{color:#312e81}h2{font-size:14pt;color:#4338ca;margin-top:22px}p{white-space:normal}hr{border:0;border-top:1px solid #ddd}</style></head><body><h1>Refined Anki Notes</h1>${body}</body></html>`;
    downloadExport(documentHtml, "application/msword", "doc");
  });

  // ============================
  // REWRITER TAB WIRING (UPDATED)
  // ============================
  let rwPreset = "general";
  let lastPreset = rwPreset;

  const ACTIVE_COLORS = {
    general: [
      "bg-slate-900",
      "text-white",
      "border",
      "border-slate-900",
      "dark:bg-slate-100",
      "dark:text-slate-900",
      "dark:border-slate-100",
      "shadow-sm",
    ],
    hpi: [
      "bg-amber-600",
      "text-white",
      "border",
      "border-amber-600",
      "dark:bg-amber-500",
      "dark:text-white",
      "dark:border-amber-500",
      "shadow-sm",
    ],
    email: [
      "bg-primary-600",
      "text-white",
      "border",
      "border-primary-600",
      "dark:bg-primary-500",
      "dark:text-white",
      "dark:border-primary-500",
      "shadow-sm",
    ],
    micro: [
      "bg-secondary-600",
      "text-white",
      "border",
      "border-secondary-600",
      "dark:bg-secondary-500",
      "dark:text-white",
      "dark:border-secondary-500",
      "shadow-sm",
    ],
    gross: [
      "bg-rose-600",
      "text-white",
      "border",
      "border-rose-600",
      "dark:bg-rose-500",
      "dark:text-white",
      "dark:border-rose-500",
      "shadow-sm",
    ],
    gross_photo: [
      "bg-pink-600",
      "text-white",
      "border",
      "border-pink-600",
      "dark:bg-pink-500",
      "dark:text-white",
      "dark:border-pink-500",
      "shadow-sm",
    ],
    path: [
      "bg-purple-600",
      "text-white",
      "border",
      "border-purple-600",
      "dark:bg-purple-500",
      "dark:text-white",
      "dark:border-purple-500",
      "shadow-sm",
    ],
    frozens_helper: [
      "bg-indigo-600",
      "text-white",
      "border",
      "border-indigo-600",
      "dark:bg-indigo-500",
      "dark:text-white",
      "dark:border-indigo-500",
      "shadow-sm",
    ],
    hpi_conciser: [
      "bg-cyan-600","text-white","border","border-cyan-600","dark:bg-cyan-500","dark:text-white","dark:border-cyan-500","shadow-sm",
    ],
  };

  const INACTIVE_COLORS = [
    "bg-white/70",
    "text-slate-700",
    "border",
    "border-slate-200",
    "shadow-sm",
  ];

  const rwInput = document.getElementById("rwInput");
  const rwOutput = document.getElementById("rwOutput");
  const rwRun = document.getElementById("rwRun");
  const rwClear = document.getElementById("rwClear");
  const rwRules = document.getElementById("rwRules");
  const rwTemplateWrap = document.getElementById("rwTemplateWrap");
  const rwTemplateLabel = document.getElementById("rwTemplateLabel");
  const rwTemplate = document.getElementById("rwTemplate");
  const rwKeepRules = document.getElementById("rwKeepRules");
  const rwPhotoUploadWrap = document.getElementById("rwPhotoUploadWrap");
  const rwPhotoInput = document.getElementById("rwPhotoInput");
  const rwPhotoList = document.getElementById("rwPhotoList");
  const rwFrozensTools = document.getElementById("rwFrozensTools");
  const rwFrozensDropZone = document.getElementById("rwFrozensDropZone");
  const rwFrozensImageStatus = document.getElementById("rwFrozensImageStatus");
  const rwPresetBtns = document.querySelectorAll(".rwPreset");
  const rwHpiConciserTools = document.getElementById("rwHpiConciserTools");
  const hpiVeryConcise = document.getElementById("hpiVeryConcise");
  const hpiIncludeProcedure = document.getElementById("hpiIncludeProcedure");
  const hpiExtraInstruction = document.getElementById("hpiExtraInstruction");
  const rwCopy = document.getElementById("rwCopy");
  const rwCorrected = document.getElementById("rwCorrected");

  const LEARNING_PRESETS = new Set(["micro", "gross", "path"]);
  const LEARNING_KEY = "rwPresetLearning";

  if (rwInput && rwOutput && rwRun && rwClear && rwRules && rwCopy && rwCorrected && rwPresetBtns.length) {
    // Preserve each preset button's original classes (padding/rounded/etc.)
    rwPresetBtns.forEach((btn) => {
      btn.dataset.baseClass = btn.className;
      btn.setAttribute("type", "button");
      btn.setAttribute("aria-pressed", "false"); // used by CSS to distinguish active/inactive hover
    });

    // Keep-rules toggle persistence
    const KEEP_RULES_KEY = "rwKeepRules";
    if (rwKeepRules) {
      rwKeepRules.checked = localStorage.getItem(KEEP_RULES_KEY) === "true";
      rwKeepRules.addEventListener("change", () => {
        localStorage.setItem(KEEP_RULES_KEY, String(rwKeepRules.checked));
      });
    }

    let rwGrossPhotoDataUrls = [];
    let rwFrozensImageText = "";
    function setFrozensImageState(loaded, message) {
      if (rwFrozensImageStatus) rwFrozensImageStatus.textContent = loaded ? `✅ ${message}` : message;
      if (rwFrozensDropZone) {
        rwFrozensDropZone.classList.toggle("border-emerald-500", loaded);
        rwFrozensDropZone.classList.toggle("dark:border-emerald-400", loaded);
        rwFrozensDropZone.classList.toggle("bg-emerald-50", loaded);
        rwFrozensDropZone.classList.toggle("dark:bg-emerald-950/30", loaded);
      }
    }

    function renderGrossPhotoList() {
      if (!rwPhotoList) return;
      if (!rwGrossPhotoDataUrls.length) {
        rwPhotoList.textContent = "No images selected.";
        return;
      }
      rwPhotoList.textContent = `${rwGrossPhotoDataUrls.length} image(s) attached for gross photo mode.`;
    }

    function setGrossPhotoVisibility(preset) {
      if (!rwPhotoUploadWrap) return;
      rwPhotoUploadWrap.classList.toggle("hidden", preset !== "gross_photo");
    }
    function setFrozensVisibility(preset) {
      if (!rwFrozensTools) return;
      rwFrozensTools.classList.toggle("hidden", preset !== "frozens_helper");
    }
    function setHpiConciserVisibility(preset) {
      if (!rwHpiConciserTools) return;
      rwHpiConciserTools.classList.toggle("hidden", preset !== "hpi_conciser");
    }
    function normalizeName(name) {
      return String(name || "")
        .replace(/\[[^\]]*]/g, "")
        .replace(/\b(MD|DO|PA-C|PA|NP|RN|MBA|PhD|DDS|DPM)\b\.?/gi, "")
        .replace(/\s+/g, " ")
        .replace(/,\s*$/, "")
        .trim();
    }
    function cleanPatient(name) {
      return normalizeName(name)
        .replace(/\b\d{1,3}\s*[MF]\b/gi, "")
        .replace(/\b(?:male|female)\b/gi, "")
        .replace(/\s+/g, " ")
        .trim();
    }
    function formatNameNoComma(name) {
      const cleaned = normalizeName(name).replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
      if (!cleaned) return "";
      const parts = cleaned.split(" ").filter(Boolean);
      if (parts.length < 2) return cleaned;
      return `${parts[0]}, ${parts.slice(1).join(" ")}`;
    }

    const FROZENS_NAME_STOP_WORDS = new Set([
      "And", "Anterior", "Base", "Biopsy", "Bilateral", "Cheek", "Closure", "Complex", "Dissection",
      "Drainage", "Eua", "Excision", "Flap", "Forearm", "Free", "Graft", "Incision", "Laryngopharyngectomy",
      "Left", "Local", "Lymph", "Mass", "Melanoma", "Neck", "Node", "Of", "Or", "Radial", "Resection",
      "Right", "Sentinel", "Skin", "Split", "Thickness", "Tongue", "Total", "Wide", "With",
    ]);

    function isLikelyNameWord(word) {
      return /^[A-Z][a-z'\-]+$/.test(word) && !FROZENS_NAME_STOP_WORDS.has(word);
    }

    function formatSurgeonNameFromWords(words) {
      const parts = words.filter(Boolean);
      if (parts.length < 2) return "";
      return `${parts[0]}, ${parts.slice(1).join(" ")}`;
    }

    function findEmbeddedSurgeonInProcedure(procedure) {
      const source = String(procedure || "");
      const wordMatches = Array.from(source.matchAll(/\b[A-Z][A-Za-z'\-]+\b/g));
      let best = null;

      for (let i = 0; i < wordMatches.length; i += 1) {
        if (!isLikelyNameWord(wordMatches[i][0])) continue;

        const words = [wordMatches[i]];
        let j = i + 1;
        while (j < wordMatches.length && j - i < 3 && isLikelyNameWord(wordMatches[j][0])) {
          const between = source.slice(words[words.length - 1].index + words[words.length - 1][0].length, wordMatches[j].index);
          if (!/^\s+$/.test(between)) break;
          words.push(wordMatches[j]);
          j += 1;
        }

        if (words.length < 2) continue;

        const prevWord = wordMatches[i - 1]?.[0] || "";
        const nextWord = wordMatches[j]?.[0] || "";
        const hasProcedureBoundary = !prevWord || FROZENS_NAME_STOP_WORDS.has(prevWord) || /[;,]\s*$/.test(source.slice(Math.max(0, words[0].index - 3), words[0].index));
        const returnsToProcedure = !nextWord || FROZENS_NAME_STOP_WORDS.has(nextWord);
        if (!hasProcedureBoundary || !returnsToProcedure) continue;

        const start = words[0].index;
        const end = words[words.length - 1].index + words[words.length - 1][0].length;
        const raw = source.slice(start, end);
        const candidate = {
          raw,
          name: formatSurgeonNameFromWords(words.map((word) => word[0])),
          start,
          end,
          score: words.length,
        };
        if (!best || candidate.score > best.score) best = candidate;
      }

      return best;
    }

    function looksLikeProcedureFragment(value) {
      const text = String(value || "").trim();
      if (!text) return true;
      return /\b(?:And|Of|Melanoma|Mass|Biopsy|Excision|Resection|Dissection)\b/i.test(text);
    }

    function removeTextSpan(source, span) {
      if (!span) return source;
      return `${source.slice(0, span.start)} ${source.slice(span.end)}`.replace(/\s+/g, " ").trim();
    }

    function sanityCheckFrozensRow(row) {
      const checked = { ...row };
      const embeddedSurgeon = findEmbeddedSurgeonInProcedure(checked.procedure);
      if (embeddedSurgeon && (!checked.surgeon || looksLikeProcedureFragment(checked.surgeon) || embeddedSurgeon.score >= 3)) {
        if (!checked.patient && checked.surgeon && !looksLikeProcedureFragment(checked.surgeon)) {
          checked.patient = checked.surgeon;
        }
        checked.surgeon = embeddedSurgeon.name;
        checked.procedure = cleanProcedure(removeTextSpan(checked.procedure, embeddedSurgeon));
      }
      return checked;
    }

    function findSurgeonBox(text) {
      const source = String(text || "");
      const bracketMatches = Array.from(source.matchAll(/\[\s*\d[\d\s,.-]*\]/g));
      for (let i = bracketMatches.length - 1; i >= 0; i -= 1) {
        const bracket = bracketMatches[i];
        const bracketStart = bracket.index || 0;
        const prefix = source.slice(0, bracketStart).replace(/\s+/g, " ").trim();
        const tail = prefix.slice(-100).trim();
        const commaNameMatch = tail.match(/((?:[A-Za-z'\-]+(?:\s+[A-Za-z'\-]+){0,2}),\s*[A-Za-z'\-]+(?:\s+[A-Za-z'\-]+){0,2}(?:\s*,?\s*(?:Md|MD|Do|DO))?)\s*$/);
        let name = commaNameMatch ? normalizeName(commaNameMatch[1]) : "";
        let nameStart = commaNameMatch ? bracketStart - tail.length + commaNameMatch.index : -1;

        if (!name) {
          const withoutCredentials = tail.replace(/\b(?:Md|MD|Do|DO)\b\.?\s*$/g, "").trim();
          const wordMatches = Array.from(withoutCredentials.matchAll(/\b[A-Z][A-Za-z'\-]+\b/g));
          const nameWords = wordMatches.slice(-2).map((match) => match[0]);
          if (nameWords.length >= 2) {
            name = formatNameNoComma(nameWords.join(" "));
            nameStart = bracketStart - tail.length + wordMatches[wordMatches.length - nameWords.length].index;
          }
        }

        if (name) {
          return {
            name,
            start: Math.max(0, nameStart),
            end: bracketStart + bracket[0].length,
            raw: source.slice(Math.max(0, nameStart), bracketStart + bracket[0].length),
          };
        }
      }
      return null;
    }

    function cleanProcedure(proc) {
      return String(proc || "")
        .replace(/\[[^\]]*]/g, "")
        .replace(/\b\d+\.\s*/g, "")
        .replace(/\b\d+\)\s*/g, "")
        .replace(/\bNeurolysis:\s*/gi, "neurolysis ")
        .replace(/\b3\.\s.*$/i, "")
        .replace(/\bComplex Closure\b.*$/i, "")
        .replace(/\bIntra-?Op\b.*$/i, "")
        .replace(/\bExcision,\s*Soft Tissue Mass,\s*Deep To Fascia,\s*(Left|Right)\s+([A-Za-z ]+)/gi, "Excision $1 $2 soft tissue mass")
        .replace(/\bExcision,\s*Subcutaneous\s*(Left|Right)\s+([A-Za-z ]+?)\s+Cyst,\s*\d+\s*cm/gi, "Excision $1 $2 cyst")
        .replace(/\bExcision\s+Subcutaneous\s+(Left|Right)\s+([A-Za-z ]+?)\s+Cyst\s*\d+\s*cm/gi, "Excision $1 $2 cyst")
        .replace(/\bRadical Resection\s+(Left|Right)\s+([A-Za-z ]+?)\s+Soft Tissue Sarcoma,\s*neurolysis\s*:?/gi, "Radical resection $1 $2 soft tissue sarcoma with neurolysis ")
        .replace(/\b(Thyroidectomy),\s*Total\s*Or\s*Subtotal\s*,\s*(Dissection,\s*Neck)\b/gi, "$1, Total or Subtotal, $2")
        .replace(/\s*,\s*/g, " ")
        .replace(/\s+/g, " ")
        .replace(/\s+\.\s*$/g, "")
        .replace(/\b(\d+\.)/g, "")
        .trim()
        .replace(/^./, (c) => c.toUpperCase());
    }
    function convertFrozensText(raw) {
      const lines = String(raw || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const out = [];
      for (const line of lines) {
        const time = (line.match(/\b\d{1,2}:\d{2}\b|\b\d{3,4}\b/) || [""])[0];
        const mrn = (line.match(/\b\d{6,10}\b/) || [""])[0];
        const surgeonBox = findSurgeonBox(line);
        const providerMatch = line.match(/([A-Za-z' -]+,\s*[A-Za-z' -]+(?:\s+[A-Za-z' -]+)?)\s*(?:\[|\bMD\b|\bDO\b)/);
        const surgeon = surgeonBox?.name || normalizeName(providerMatch ? providerMatch[1] : "");
        const patientMatch = line.match(/\b([A-Za-z' -]+,\s*[A-Za-z' -]+)(?:\s+\d{1,3}\s*[MF])?/);
        const patient = cleanPatient(patientMatch ? patientMatch[1] : "");
        let procedure = line;
        [time, mrn, surgeonBox?.raw, surgeon, patient].filter(Boolean).forEach((chunk) => {
          procedure = procedure.replace(chunk, " ");
        });
        procedure = cleanProcedure(procedure);
        if (time || surgeon || procedure || mrn || patient) {
          const checked = sanityCheckFrozensRow({ time, orRoom: "", patient, procedure, mrn, surgeon });
          out.push([checked.time, checked.patient, checked.procedure, checked.mrn, checked.surgeon].join("\t"));
        }
      }
      return out.join("\n");
    }
    function parseFrozensRows(raw) {
      const compact = String(raw || "").replace(/\|/g, " ").replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
      if (!compact) return [];

      const timeMatch = compact.match(/\b([01]?\d|2[0-3])[:.]?[0-5]\d\b|\b\d{4}\b/);
      const time = (timeMatch?.[0] || "").replace(".", ":");
      const orRoomRaw = (compact.match(/\b([A-Z]{2,5}\s*\d{1,2})\b/) || ["", ""])[1];
      const orRoom = (orRoomRaw || "").replace(/^([A-Z]{3})O(\d{2})$/i, "$1 $2").replace(/^([A-Z]{2,5})\s*(\d{1,2})$/, "$1 $2");
      const mrnMatch = compact.match(/\b(\d{6,10})\b/);
      const mrn = mrnMatch?.[1] || "";
      if (!mrn) return [];

      const beforeMrn = compact.slice(0, mrnMatch.index).trim();
      const afterMrn = compact.slice((mrnMatch.index || 0) + mrn.length).trim();

      const patientChunk = beforeMrn
        .replace(new RegExp(`\\b${time.replace(":", "[:.]?")}\\b`, "i"), " ")
        .replace(orRoom, " ")
        .replace(/\s+/g, " ")
        .trim();
      const patientMatch = patientChunk.match(/([A-Za-z' -]+,\s*[A-Za-z' -]+(?:\s+[A-Za-z' -]+)?)/);
      const patient = cleanPatient(patientMatch?.[1] || patientChunk)
        .replace(/\b(Male|Female)\b/gi, "")
        .replace(/\b\d{1,3}\s*years?\b/gi, "")
        .replace(/\s+/g, " ")
        .trim();

      const surgeonBox = findSurgeonBox(afterMrn);
      const surgeonTailMatch = surgeonBox ? null : afterMrn.match(/([A-Za-z' -]+,\s*[A-Za-z' -]+(?:\s+[A-Za-z' -]+)?(?:\s*,?\s*(?:Md|MD|Do|DO))?(?:\s*\[[^\]]+\])?)\s*$/);
      const surgeonNoCommaMatch = surgeonBox ? null : afterMrn.match(/\b([A-Z][a-z'\-]+\s+[A-Z][a-z'\-]+(?:\s+[A-Z][a-z'\-]+)?)\s+(?:Md|MD|Do|DO)\b/);
      const surgeonRaw = surgeonTailMatch?.[1] || surgeonNoCommaMatch?.[1] || "";
      const surgeon = (surgeonBox?.name || (surgeonTailMatch ? normalizeName(surgeonRaw) : formatNameNoComma(surgeonRaw))).replace(/\s+/g, " ").trim();

      let procedureRaw = surgeonBox
        ? `${afterMrn.slice(0, surgeonBox.start)} ${afterMrn.slice(surgeonBox.end)}`.trim()
        : surgeonTailMatch
          ? afterMrn.slice(0, surgeonTailMatch.index).trim()
          : afterMrn;
      procedureRaw = procedureRaw
        .replace(/([A-Za-z' -]+,\s*[A-Za-z' -]+(?:\s+[A-Za-z' -]+)?(?:\s*,?\s*(?:Md|MD|Do|DO))?(?:\s*\[[^\]]+\])?)\s*$/i, " ")
        .replace(/\b(Male|Female)\b/gi, " ")
        .replace(/\b\d{1,3}\s*years?\b/gi, " ")
        .replace(/\b(?:Md|MD|Do|DO)\b/g, " ")
        .replace(/\[[^\]]*]/g, " ")
        .replace(/\b([A-Z][a-z'\-]+\s+[A-Z][a-z'\-]+(?:\s+[A-Z][a-z'\-]+)?)\b/g, (m) => {
          // remove likely provider names embedded in OCR procedure line
          if (surgeonRaw && m.toLowerCase() === surgeonRaw.toLowerCase()) return " ";
          return m;
        })
        .replace(/\s+/g, " ")
        .trim();
      let procedure = cleanProcedure(procedureRaw)
        .replace(/\bEua\b/gi, "EUA")
        .replace(/\bAnoscpopy\b/gi, "anoscopy")
        .replace(/\bTransrectal\b/gi, "")
        .replace(/\s+/g, " ")
        .trim();
      procedure = procedure
        .replace(/\bIncision And Drainage Of\b/gi, "incision and drainage of")
        .replace(/\bEUA\s+anoscopy\b/i, "EUA, anoscopy")
        .replace(/^([A-Z]{2,}),\s*/i, "$1, ");

      return [sanityCheckFrozensRow({ time, orRoom, surgeon, procedure, mrn, patient })];
    }
    function normalizeFrozensOcrText(text) {
      return String(text || "")
        .replace(/[|]/g, " ")
        .replace(/[“”]/g, '"')
        .replace(/[’]/g, "'")
        .replace(/CEN0(\d)/gi, "CEN $1")
        .replace(/CEN(\d{2})/gi, "CEN $1")
        .replace(/([A-Z]{3})O(\d{2})/g, "$1 $2")
        .replace(/0R/g, "OR")
        .replace(/\s+/g, " ")
        .trim();
    }
    async function ocrFrozensImage(file) {
      if (!window.Tesseract) throw new Error("OCR library unavailable.");
      const result = await window.Tesseract.recognize(file, "eng", {
        tessedit_pageseg_mode: "6",
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789,:.-[]()/# '&",
      });
      return normalizeFrozensOcrText(String(result?.data?.text || ""));
    }

    async function fileToDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("Failed to read image file."));
        reader.readAsDataURL(file);
      });
    }

    async function attachGrossPhotos(files, { replaceExisting = false } = {}) {
      const validFiles = Array.from(files || []).filter((file) => String(file?.type || "").startsWith("image/"));
      if (!validFiles.length) return;

      const roomLeft = Math.max(0, 2 - (replaceExisting ? 0 : rwGrossPhotoDataUrls.length));
      if (roomLeft <= 0) {
        setStatus("Already attached 2 images. Clear or switch preset to add different photos.");
        return;
      }

      const filesToUse = validFiles.slice(0, roomLeft);
      if (validFiles.length > roomLeft) {
        setStatus("Only up to 2 images are allowed. Extra image(s) were ignored.");
      }

      try {
        const incoming = await Promise.all(filesToUse.map((file) => fileToDataUrl(file)));
        rwGrossPhotoDataUrls = replaceExisting ? incoming : [...rwGrossPhotoDataUrls, ...incoming].slice(0, 2);
        renderGrossPhotoList();
        setStatus(`Attached ${rwGrossPhotoDataUrls.length} image(s) for gross photo mode.`);
      } catch (err) {
        console.error("Image upload error:", err);
        if (replaceExisting) rwGrossPhotoDataUrls = [];
        renderGrossPhotoList();
        setStatus("Could not read selected image(s). Please try again.");
      }
    }

    if (rwPhotoInput) {
      rwPhotoInput.addEventListener("change", async () => {
        const files = Array.from(rwPhotoInput.files || []);
        if (!files.length) {
          rwGrossPhotoDataUrls = [];
          renderGrossPhotoList();
          return;
        }

        if (files.length > 2) {
          setStatus("Please select up to 2 images for gross photo mode.");
          rwPhotoInput.value = "";
        }

        await attachGrossPhotos(files, { replaceExisting: true });
      });
    }

    function setPlaceholdersForPreset(_preset) {
      rwInput.placeholder = _preset === "gross_photo"
        ? "Optional context (e.g., specimen type, side, procedure, key findings)…"
        : _preset === "frozens_helper"
          ? "Paste or drop an OR schedule screenshot; OCR text is added automatically."
        : _preset === "hpi_conciser"
          ? "Paste clinical history/HPI text. Output will be concise and Excel-ready."
        : _preset === "hpi"
          ? "Paste timeline details (diagnosis, imaging, prior pathology, treatment history, surgeries)…"
          : "Ask anything or paste text here";
      rwRules.placeholder =
        "Optional: add constraints (tone, bullets, length, style). Leave empty for default behavior.";
      if (rwTemplate) {
        if (_preset === "gross") {
          rwTemplate.placeholder =
            "Optional template for gross description output (structure, sections, format)…";
        } else {
          rwTemplate.placeholder =
            "Optional template for micro findings output (structure, headings, format)…";
        }
      }
    }

    function syncTemplateVisibility(preset) {
      if (!rwTemplateWrap) return;
      const supportsTemplate = preset === "micro" || preset === "gross";
      rwTemplateWrap.classList.toggle("hidden", !supportsTemplate);

      if (rwTemplateLabel) {
        rwTemplateLabel.textContent = preset === "gross" ? "Template (Gross)" : "Template (Micro)";
      }
    }

    function loadLearningStore() {
      try {
        const parsed = JSON.parse(localStorage.getItem(LEARNING_KEY) || "{}");
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch {
        return {};
      }
    }

    function saveLearningStore(store) {
      localStorage.setItem(LEARNING_KEY, JSON.stringify(store));
    }

    function addLearningExample(preset, inputText, outputText) {
      if (!LEARNING_PRESETS.has(preset)) return;

      const cleanedInput = String(inputText || "").trim();
      const cleanedOutput = String(outputText || "").trim();
      if (!cleanedInput || !cleanedOutput) return;

      const store = loadLearningStore();
      const bucket = Array.isArray(store[preset]) ? store[preset] : [];
      bucket.push({
        input: cleanedInput.slice(0, 1400),
        output: cleanedOutput.slice(0, 2400),
        savedAt: new Date().toISOString(),
      });

      store[preset] = bucket.slice(-20);
      saveLearningStore(store);
    }

    function getLearningExamples(preset) {
      if (!LEARNING_PRESETS.has(preset)) return [];

      const store = loadLearningStore();
      const bucket = Array.isArray(store[preset]) ? store[preset] : [];
      return bucket.slice(-5);
    }

    function isAdaptivePreset(preset) {
      return LEARNING_PRESETS.has(preset);
    }

    function updateCorrectedButtonState() {
      const hasInput = String(rwInput?.value || "").trim().length > 0;
      const hasOutput = String(getRwOutputRaw() || "").trim().length > 0;
      rwCorrected.disabled = !(isAdaptivePreset(rwPreset) && hasInput && hasOutput);
    }

    function applyRulesForPreset(_preset) {
      // Do nothing — rules box is user-controlled.
    }

    function setRunButtonLabel(preset) {
      rwRun.textContent = preset === "frozens_helper" ? "Convert to Excel Row" : preset === "general" ? "Send ➜" : preset === "gross_photo" ? "Describe Photo ✨" : preset === "hpi" ? "Generate HPI ✨" : preset === "hpi_conciser" ? "Concise HPI" : "Refine ✨";
    }

    const HPI_SUPER_CONDENSED_MAX_CHARS = 208;

    function normalizeOutputText(text) {
      return String(text || "")
        .replace(/\r\n/g, "\n")
        .replace(/\\n/g, "\n")
        .trim();
    }

    function enforceMaxChars(text, maxChars) {
      const normalized = normalizeOutputText(text).replace(/\s+/g, " ").trim();
      if (!Number.isFinite(maxChars) || maxChars <= 0 || normalized.length <= maxChars) return normalized;

      const sliceLimit = Math.max(1, maxChars - 1);
      let truncated = normalized.slice(0, sliceLimit);
      const lastSpace = truncated.lastIndexOf(" ");
      if (lastSpace > Math.floor(sliceLimit * 0.6)) truncated = truncated.slice(0, lastSpace);

      truncated = truncated.replace(/[\s,;:()\-]+$/g, "").trim();
      if (!truncated) return normalized.slice(0, maxChars);
      return `${truncated}.`.slice(0, maxChars);
    }

    function escapeHtml(text) {
      return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function formatInlineMarkdown(text) {
      let out = escapeHtml(text);
      out = out.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      out = out.replace(/__(.+?)__/g, "<u>$1</u>");
      out = out.replace(/\*(.+?)\*/g, "<em>$1</em>");
      return out;
    }

    function renderOutputRichText(rawText) {
      const normalized = normalizeOutputText(rawText);
      const lines = normalized.split("\n");
      const htmlParts = [];
      let inList = false;

      for (const line of lines) {
        const trimmed = line.trim();

        if (!trimmed) {
          if (inList) {
            htmlParts.push("</ul>");
            inList = false;
          }
          htmlParts.push('<div class="h-3"></div>');
          continue;
        }

        const bulletMatch = line.match(/^\s*-\s+(.+)$/);
        if (bulletMatch) {
          if (!inList) {
            htmlParts.push('<ul class="list-disc pl-6 space-y-1">');
            inList = true;
          }
          htmlParts.push(`<li>${formatInlineMarkdown(bulletMatch[1])}</li>`);
          continue;
        }

        if (inList) {
          htmlParts.push("</ul>");
          inList = false;
        }

        const h3Match = trimmed.match(/^###\s+(.+)$/);
        if (h3Match) {
          htmlParts.push(`<h3 class="text-base font-semibold">${formatInlineMarkdown(h3Match[1])}</h3>`);
          continue;
        }

        htmlParts.push(`<p>${formatInlineMarkdown(trimmed)}</p>`);
      }

      if (inList) htmlParts.push("</ul>");

      return {
        normalized,
        html: htmlParts.join(""),
      };
    }

    function getRwOutputRaw() {
      const fromDataset = rwOutput?.dataset?.raw || "";
      if (fromDataset) return fromDataset;

      const fromRenderedText = String(rwOutput?.value || "")
        .replace(/\u00A0/g, " ")
        .replace(/\r\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      return fromRenderedText;
    }

    function stripMarkdownForCopy(text) {
      return text
        .replace(/^\s{0,3}#{1,6}\s+/gm, "")
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/__(.*?)__/g, "$1")
        .replace(/\*(.*?)\*/g, "$1")
        .trim();
    }

    function getRwOutputPlainText() {
      const normalized = String(rwOutput?.value || "")
        .replace(/\u00A0/g, " ")
        .replace(/\r\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      return stripMarkdownForCopy(normalized);
    }

    function setPresetActive(preset) {
      rwPresetBtns.forEach((b) => b.setAttribute("aria-pressed", "false"));

      rwPresetBtns.forEach((b) => {
        b.className = b.dataset.baseClass || b.className;
        b.classList.add(...INACTIVE_COLORS);
      });

      const activeBtn = document.querySelector(`.rwPreset[data-preset="${preset}"]`);
      if (activeBtn) {
        activeBtn.setAttribute("aria-pressed", "true");
        activeBtn.className = activeBtn.dataset.baseClass || activeBtn.className;
        activeBtn.classList.add(...(ACTIVE_COLORS[preset] || ACTIVE_COLORS.general));
      }
    }


    const RW_OUTPUT_INPUT_STYLE_CLASSES = [
      "font-sans",
      "text-[15px]",
      "leading-relaxed",
      "tracking-tight",
      "whitespace-pre-wrap",
      "break-words",
    ];
    const RW_OUTPUT_FROZENS_STYLE_CLASSES = [
      "font-mono",
      "text-[14px]",
      "leading-relaxed",
      "tracking-tight",
      "whitespace-pre",
    ];

    function setRwOutputTypography(preset) {
      if (!rwOutput) return;
      rwOutput.classList.remove(...RW_OUTPUT_INPUT_STYLE_CLASSES, ...RW_OUTPUT_FROZENS_STYLE_CLASSES);
      if (preset === "frozens_helper") {
        rwOutput.classList.add(...RW_OUTPUT_FROZENS_STYLE_CLASSES);
      } else {
        rwOutput.classList.add(...RW_OUTPUT_INPUT_STYLE_CLASSES);
      }
    }

    function clearRewriterFields({ clearRules } = { clearRules: true }) {
      rwInput.value = "";
      rwOutput.value = "";
      rwOutput.dataset.raw = "";
      rwCopy.disabled = true;
      rwCorrected.disabled = true;
      if (clearRules) rwRules.value = "";
      if (rwTemplate && rwPreset !== "micro" && rwPreset !== "gross") rwTemplate.value = "";
      rwGrossPhotoDataUrls = [];
      rwFrozensImageText = "";
      setFrozensImageState(false, "Waiting for screenshot…");
      if (rwPhotoInput) rwPhotoInput.value = "";
      renderGrossPhotoList();
    }

    // Enter = submit, Shift + Enter = newline (rwInput)
    rwInput.addEventListener("keydown", (e) => {
      const isShiftEnter = e.shiftKey;
      const isEnter = e.key === "Enter" || e.key === "NumpadEnter";
      if (!isEnter) return;

      if (isShiftEnter) {
        e.preventDefault();
        const start = rwInput.selectionStart ?? rwInput.value.length;
        const end = rwInput.selectionEnd ?? rwInput.value.length;
        rwInput.value = rwInput.value.slice(0, start) + "\n" + rwInput.value.slice(end);
        rwInput.selectionStart = rwInput.selectionEnd = start + 1;
        return;
      }

      e.preventDefault();
      rwRun.click();
    });

    rwInput.addEventListener("paste", async (e) => {
      if (rwPreset !== "gross_photo" && rwPreset !== "frozens_helper") return;

      const items = Array.from(e.clipboardData?.items || []);
      const imageFiles = items
        .filter((item) => item.kind === "file" && String(item.type || "").startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter(Boolean);

      if (!imageFiles.length) return;

      e.preventDefault();
      if (rwPreset === "gross_photo") {
        await attachGrossPhotos(imageFiles, { replaceExisting: false });
      } else if (rwPreset === "frozens_helper") {
        try {
          rwFrozensImageText = await ocrFrozensImage(imageFiles[0]);
          setFrozensImageState(true, "Screenshot loaded successfully");
          setStatus("OCR complete for Frozens Helper image.");
        } catch (err) {
          console.error(err);
          setStatus("OCR failed for image.");
        }
      }
    });
    if (rwFrozensDropZone) {
      rwFrozensDropZone.addEventListener("paste", async (e) => {
        if (rwPreset !== "frozens_helper") return;
        const items = Array.from(e.clipboardData?.items || []);
        const file = items.find((item) => item.kind === "file" && String(item.type || "").startsWith("image/"))?.getAsFile();
        if (!file) return;
        e.preventDefault();
        setFrozensImageState(false, "Running OCR…");
        rwFrozensImageText = await ocrFrozensImage(file);
        setFrozensImageState(true, "Screenshot loaded successfully");
      });
      rwFrozensDropZone.addEventListener("dragover", (e) => e.preventDefault());
      rwFrozensDropZone.addEventListener("drop", async (e) => {
        if (rwPreset !== "frozens_helper") return;
        e.preventDefault();
        const file = Array.from(e.dataTransfer?.files || []).find((f) => String(f.type || "").startsWith("image/"));
        if (!file) return;
        setFrozensImageState(false, "Running OCR…");
        rwFrozensImageText = await ocrFrozensImage(file);
        setFrozensImageState(true, "Screenshot loaded successfully");
      });
    }

    // Enter = submit, Ctrl/Cmd + Enter = newline (rwRules)
    rwRules.addEventListener("keydown", (e) => {
      const isCmdOrCtrl = e.ctrlKey || e.metaKey;
      const isEnter = e.key === "Enter" || e.key === "NumpadEnter";
      if (!isEnter) return;

      if (isCmdOrCtrl) {
        e.preventDefault();
        const start = rwRules.selectionStart ?? rwRules.value.length;
        const end = rwRules.selectionEnd ?? rwRules.value.length;
        rwRules.value = rwRules.value.slice(0, start) + "\n" + rwRules.value.slice(end);
        rwRules.selectionStart = rwRules.selectionEnd = start + 1;
        return;
      }

      e.preventDefault();
      rwRun.click();
    });

    // Copy output
    rwCopy.disabled = true;
    rwCorrected.disabled = true;
    const rwCopyOriginal = { className: rwCopy.className, text: rwCopy.textContent };

    rwOutput.addEventListener("input", () => {
      const liveText = getRwOutputRaw();
      rwOutput.dataset.raw = liveText;
      rwCopy.disabled = !liveText;
      updateCorrectedButtonState();
    });

    rwCopy.addEventListener("click", async () => {
      const text = getRwOutputPlainText() || getRwOutputRaw();
      if (!text) return;

      try {
        await navigator.clipboard.writeText(text);
        rwCopy.textContent = "Copied!";
        rwCopy.className = rwCopyOriginal.className + " bg-green-500 text-white";
        setStatus("Copied output to clipboard.");

        setTimeout(() => {
          rwCopy.textContent = rwCopyOriginal.text;
          rwCopy.className = rwCopyOriginal.className;
        }, 350);
      } catch (err) {
        console.error("Copy failed:", err);
        setStatus("Copy failed.");
      }
    });
    rwOutput.addEventListener("click", () => {
      if (rwPreset !== "frozens_helper") return;
      rwOutput.focus();
      rwOutput.select();
    });

    const rwCorrectedOriginal = {
      className: rwCorrected.className,
      text: rwCorrected.textContent,
    };

    rwCorrected.addEventListener("click", async () => {
      const sourceText = String(rwInput.value || "").trim();
      const correctedText = String(getRwOutputRaw() || "").trim();

      if (!isAdaptivePreset(rwPreset)) {
        return setStatus("Save Corrected is only for Micro, Gross, and Path presets.");
      }
      if (!sourceText || !correctedText) {
        return setStatus("Need both input and corrected output to save learning.");
      }

      rwCorrected.disabled = true;
      rwCorrected.textContent = "Saving…";

      try {
        await apiPostJson("/api/rewrite/learn", {
          preset: rwPreset,
          input: sourceText,
          output: correctedText,
        });

        addLearningExample(rwPreset, sourceText, correctedText);
        rwCorrected.textContent = "Saved ✓";
        rwCorrected.className = rwCorrectedOriginal.className + " bg-emerald-600 text-white";
        setStatus(`Saved corrected example for ${rwPreset}.`);

        setTimeout(() => {
          rwCorrected.textContent = rwCorrectedOriginal.text;
          rwCorrected.className = rwCorrectedOriginal.className;
          updateCorrectedButtonState();
        }, 500);
      } catch (err) {
        console.error("Save corrected failed:", err);
        setStatus("Save corrected failed: " + (err?.message || String(err)));
        rwCorrected.textContent = rwCorrectedOriginal.text;
        rwCorrected.className = rwCorrectedOriginal.className;
        updateCorrectedButtonState();
      }
    });

    // Preset buttons (clear on change; keep rules if toggle on)
    rwPresetBtns.forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const nextPreset = btn.dataset.preset || "general";

        if (nextPreset !== lastPreset) {
          const keepRules = rwKeepRules?.checked === true;
          clearRewriterFields({ clearRules: !keepRules });
          setStatus("");
        }

        rwPreset = nextPreset;
        lastPreset = nextPreset;

        setPresetActive(rwPreset);
        applyRulesForPreset(rwPreset);
        setPlaceholdersForPreset(rwPreset);
        syncTemplateVisibility(rwPreset);
        setGrossPhotoVisibility(rwPreset);
        setFrozensVisibility(rwPreset);
        setHpiConciserVisibility(rwPreset);
        setRunButtonLabel(rwPreset);
        setRwOutputTypography(rwPreset);
        updateCorrectedButtonState();

        setStatus(`Rewriter mode: ${rwPreset}`);
      });
    });

    // Clear (respects Keep toggle)
    rwClear.addEventListener("click", (e) => {
      e.preventDefault();
      const keepRules = rwKeepRules?.checked === true;
      clearRewriterFields({ clearRules: !keepRules });
      setStatus("Cleared rewriter.");
      rwInput.focus();
    });

    // Run
    rwRun.addEventListener("click", async (e) => {
      e.preventDefault();
      const text = (rwInput.value || "").trim();
      if (rwPreset === "frozens_helper") {
        const combined = rwFrozensImageText;
        if (!combined.trim()) return setStatus("Paste an OR schedule screenshot first.");
        const parsedRows = parseFrozensRows(combined);
        if (!parsedRows.length) return setStatus("Could not parse schedule row.");
        const first = parsedRows[0];
        const time = String(first.time || "").replace(":", "");
        const sixColRow = [time, first.orRoom, first.patient, first.procedure, first.mrn, first.surgeon].join("\t");
        rwOutput.value = sixColRow;
        rwOutput.dataset.raw = sixColRow;
        rwCopy.disabled = !sixColRow;
        updateCorrectedButtonState();
        setStatus("Done — generated one Excel-ready row (TIME, ROOM, PATIENT, PROCEDURE, MRN, SURGEON).");
        return;
      }
      if (rwPreset === "hpi_conciser") {
        if (!text) return setStatus("Paste HPI text first.");
        const superCondensed = Boolean(hpiVeryConcise?.checked);
        const sentenceLimitRule = superCondensed
          ? `Return plain text only as exactly 1 compact sentence with a hard maximum of ${HPI_SUPER_CONDENSED_MAX_CHARS} characters, including spaces and punctuation.`
          : "Return plain text only as 1-2 compact sentences.";
        const optRules = [
          "Rewrite into concise pathology-focused medical history for a case-tracking spreadsheet.",
          sentenceLimitRule,
          "Always start with a compact age/sex token when age and sex are provided (e.g., 30M, 78F); convert forms such as '80 y.o. F' or '66-year-old male' to this format.",
          "Use high-yield pathology abbreviations when they improve concision (e.g., w/, s/p, bx, c/f, dx, hx, mets, LAD, LN, PFTs, CT/MRI/PET, XRT/RT, chemo, panc, adenocar, cholangioCA if appropriate, SCC, IDC, DCIS, PTC, PHPT, MEN1, RUL/LUL, ENE).",
          "Preserve key facts: age/sex, primary dx or mass, site/laterality, key imaging/biopsy findings, biomarkers/stage/nodal disease, mets status if relevant, and current treatment/status.",
          (superCondensed ? "For the 208-character cap, prioritize age/sex, primary dx/site, stage or mets status, and treatment/procedure context over lower-yield details." : ""),
          (hpiIncludeProcedure?.checked ? "Include key prior procedure/surgery details only when clinically relevant to pathology interpretation." : "Exclude scheduling/procedure-plan language and omit procedure/surgery details unless required to understand current pathology context."),
          "Include only pertinent dates that affect pathology interpretation or treatment chronology; remove incidental, repeated, or nonessential dates.",
          "Avoid narrative filler, symptom lists unless critical, follow-up plans, and long paragraphs.",
          String(hpiExtraInstruction?.value || "").trim(),
        ].filter(Boolean).join("\n");
        try {
          const j = await apiPostJson("/api/rewrite", {
            text,
            model: modelEl?.value || "gpt-4.1-mini",
            temperature: 0.1,
            preset: "hpi",
            rules: optRules,
            template: "",
            imageDataUrls: [],
            learningExamples: [],
            clientDateContext: getClientDateContext(),
          });
          const conciseText = superCondensed
            ? enforceMaxChars(j.text ?? "", HPI_SUPER_CONDENSED_MAX_CHARS)
            : normalizeOutputText(j.text ?? "");
          rwOutput.value = conciseText;
          rwOutput.dataset.raw = conciseText;
          rwCopy.disabled = !conciseText;
          setStatus("Done — concise HPI generated.");
        } catch (err) {
          console.error("HPI conciser error:", err);
          setStatus("HPI conciser error: " + (err?.message || String(err)));
        }
        return;
      }
      const hasGrossPhotos = rwPreset === "gross_photo" && rwGrossPhotoDataUrls.length > 0;
      if (!text && !hasGrossPhotos) return setStatus("Type text or attach gross photo image(s) first.");

      const previousAnswer = getRwOutputRaw();
      const isGeneralFollowUp = rwPreset === "general" && previousAnswer.length > 0;
      const requestText = isGeneralFollowUp
        ? `You previously answered:\n\n${previousAnswer}\n\nFollow-up question:\n${text}`
        : text;

      rwRun.disabled = true;
      rwRun.textContent = rwPreset === "general" ? "Sending…" : rwPreset === "hpi" ? "Generating HPI…" : "Refining…";
      setStatus(
        rwPreset === "general"
          ? isGeneralFollowUp
            ? "Sending follow-up…"
            : "Sending…"
          : "Refining…"
      );

      try {
        const j = await apiPostJson("/api/rewrite", {
          text: requestText,
          model: modelEl?.value || "gpt-4.1-mini",
          temperature: Number(tempEl?.value) || 0.2,
          preset: rwPreset,
          rules: rwRules.value || "",
          template: rwPreset === "micro" || rwPreset === "gross" ? rwTemplate?.value || "" : "",
          imageDataUrls: rwPreset === "gross_photo" ? rwGrossPhotoDataUrls : [],
          learningExamples: getLearningExamples(rwPreset),
          clientDateContext: getClientDateContext(),
        });
        const renderedOutput = renderOutputRichText(j.text ?? "");
        rwOutput.value = renderedOutput.normalized;
        rwOutput.dataset.raw = renderedOutput.normalized;
        rwCopy.disabled = !renderedOutput.normalized;
        updateCorrectedButtonState();
        setStatus(rwPreset === "general" ? "Done — answered." : rwPreset === "gross_photo" ? "Done — generated gross description from photo(s)." : rwPreset === "hpi" ? "Done — generated HPI paragraph." : "Done — rewritten.");
      } catch (err) {
        console.error("Rewriter error:", err);
        setStatus("Rewriter error: " + (err?.message || String(err)));
      } finally {
        rwRun.disabled = false;
        setRunButtonLabel(rwPreset);
      }
    });

    // Default preset on load
    setPresetActive("general");
    applyRulesForPreset("general");
    setPlaceholdersForPreset("general");
    syncTemplateVisibility("general");
    setGrossPhotoVisibility("general");
    setFrozensVisibility("general");
    setHpiConciserVisibility("general");
    setRunButtonLabel("general");
    setRwOutputTypography("general");
    renderGrossPhotoList();
    updateCorrectedButtonState();

    // Keep session warm so long-idle tabs still respond quickly.
    const keepAliveMs = 4 * 60 * 1000;
    const keepAliveId = window.setInterval(() => {
      pingHealth({ silent: true });
    }, keepAliveMs);

    window.addEventListener("beforeunload", () => {
      window.clearInterval(keepAliveId);
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") pingHealth({ silent: true });
    });

    pingHealth({ silent: true });
  } else {
    console.warn("Rewriter wiring skipped: missing elements or preset buttons not found.");
  }
});
