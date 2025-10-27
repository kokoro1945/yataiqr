(function () {
  const DRIVE_FOLDER_LINK =
    "https://drive.google.com/drive/folders/137A0zndjCD6DjrRT8K97IgI6XFgpv0hq?usp=drive_link";
  const CHUNK_SIZE = 5;
  const DEFAULT_QR_SIZE = 300;
  const isMac =
    typeof navigator !== "undefined" &&
    /mac/i.test(navigator.platform || navigator.userAgent || "");

  let catalogCache = null;
  let modal = null;
  let state = null;

  function matchesHotkey(event) {
    if (!event) return false;
    if (event.key.toLowerCase() !== "b") return false;
    if (!event.shiftKey) return false;
    if (event.altKey) return true;
    if (isMac && event.metaKey) return true;
    return false;
  }

  async function loadCatalog() {
    if (catalogCache) return catalogCache;
    try {
      const response = await fetch("./assets/booth_catalog.json", {
        cache: "no-store"
      });
      if (!response.ok) {
        throw new Error(`Failed to load catalog: ${response.status}`);
      }
      const data = await response.json();
      if (!Array.isArray(data)) {
        throw new Error("Catalog JSON is not an array");
      }
      catalogCache = data;
      return data;
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  function ensureModal() {
    if (modal) return modal;
    const overlay = document.createElement("div");
    overlay.className =
      "fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4";

    const dialog = document.createElement("div");
    dialog.className =
      "w-full max-w-3xl rounded-2xl bg-white shadow-2xl ring-1 ring-slate-900/10";

    const container = document.createElement("div");
    container.className = "flex flex-col gap-6 p-6 sm:p-8";
    dialog.appendChild(container);

    const header = document.createElement("header");
    header.className = "space-y-2";
    header.innerHTML = `
      <h2 class="text-lg font-semibold text-slate-900 sm:text-xl">一括QR生成モード</h2>
      <p class="text-sm text-slate-500 sm:text-base">
        指定された屋台カタログのQRコードを生成し、Googleドライブへアップロードします。
        実行中はページを閉じずにお待ちください。
      </p>
    `;
    container.appendChild(header);

    const meta = document.createElement("div");
    meta.className =
      "grid gap-2 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600";
    meta.innerHTML = `
      <div><span class="font-semibold text-slate-700">対象件数:</span> <span data-batch-total>0</span> 件</div>
      <div><span class="font-semibold text-slate-700">保存先フォルダ:</span>
        <a href="${DRIVE_FOLDER_LINK}" target="_blank" rel="noopener" class="text-orange-600 underline hover:text-orange-500">
          Google Drive フォルダを開く
        </a>
      </div>
      <div class="text-xs text-slate-500">
        ※ Drive アップロードにはサービスアカウント認証が必要です。未設定の場合はエラーになります。
      </div>
    `;
    container.appendChild(meta);

    const progressWrap = document.createElement("div");
    progressWrap.className = "space-y-2";
    progressWrap.innerHTML = `
      <div class="flex items-center justify-between text-sm text-slate-600">
        <span data-progress-label>開始待ち</span>
        <span><span data-progress-count>0</span> / <span data-progress-total>0</span></span>
      </div>
      <div class="h-2 w-full overflow-hidden rounded-full bg-slate-200">
        <div data-progress-bar class="h-full w-0 rounded-full bg-orange-500 transition-all duration-300 ease-out"></div>
      </div>
    `;
    container.appendChild(progressWrap);

    const listWrapper = document.createElement("div");
    listWrapper.className =
      "h-60 overflow-y-auto rounded-xl border border-slate-200";
    listWrapper.innerHTML = `
      <ul data-log class="divide-y divide-slate-200 bg-white text-sm text-slate-700"></ul>
    `;
    container.appendChild(listWrapper);

    const footer = document.createElement("footer");
    footer.className = "flex flex-wrap items-center justify-end gap-3";
    footer.innerHTML = `
      <button type="button" data-close class="btn-ghost">閉じる</button>
      <button type="button" data-cancel class="btn-ghost hidden">処理を中断</button>
      <button type="button" data-retry class="btn-ghost hidden">失敗分を再実行</button>
      <button type="button" data-start class="btn-primary">生成開始</button>
    `;
    container.appendChild(footer);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    modal = {
      overlay,
      dialog,
      container,
      header,
      meta,
      progress: {
        label: progressWrap.querySelector("[data-progress-label]"),
        count: progressWrap.querySelector("[data-progress-count]"),
        total: progressWrap.querySelector("[data-progress-total]"),
        bar: progressWrap.querySelector("[data-progress-bar]")
      },
      totalLabel: meta.querySelector("[data-batch-total]"),
      logList: listWrapper.querySelector("[data-log]"),
      buttons: {
        close: footer.querySelector("[data-close]"),
        cancel: footer.querySelector("[data-cancel]"),
        retry: footer.querySelector("[data-retry]"),
        start: footer.querySelector("[data-start]")
      }
    };

    modal.overlay.addEventListener("click", (event) => {
      if (event.target === modal.overlay) {
        if (!state || state.status !== "running") {
          closeModal();
        }
      }
    });

    modal.buttons.close.addEventListener("click", () => {
      if (!state || state.status !== "running") {
        closeModal();
      }
    });

    modal.buttons.start.addEventListener("click", () => {
      startBatch().catch((error) => {
        console.error(error);
        alert("一括生成の開始に失敗しました。");
      });
    });

    modal.buttons.cancel.addEventListener("click", () => {
      if (state) {
        state.aborted = true;
        modal.buttons.cancel.disabled = true;
        modal.buttons.cancel.textContent = "中断中…";
      }
    });

    modal.buttons.retry.addEventListener("click", () => {
      if (!state || !state.failures.length) return;
      retryFailures().catch((error) => {
        console.error(error);
        alert("失敗分の再実行に失敗しました。");
      });
    });

    return modal;
  }

  function openModal() {
    const modalInstance = ensureModal();
    modalInstance.overlay.classList.remove("hidden");
    modalInstance.overlay.setAttribute("aria-hidden", "false");
    modalInstance.buttons.start.focus();
    initializeState();
  }

  function closeModal() {
    if (!modal) return;
    modal.overlay.classList.add("hidden");
    modal.overlay.setAttribute("aria-hidden", "true");
  }

  function initializeState() {
    if (!modal) return;
    state = {
      status: "idle",
      total: 0,
      processed: 0,
      successes: [],
      failures: [],
      aborted: false,
      batchId: createBatchId()
    };
    modal.progress.label.textContent = "開始待ち";
    modal.progress.count.textContent = "0";
    modal.progress.total.textContent = "0";
    modal.progress.bar.style.width = "0%";
    modal.totalLabel.textContent = "0";
    modal.logList.innerHTML = "";
    modal.buttons.start.disabled = false;
    modal.buttons.cancel.classList.add("hidden");
    modal.buttons.cancel.disabled = false;
    modal.buttons.cancel.textContent = "処理を中断";
    modal.buttons.retry.classList.add("hidden");
  }

  function createBatchId() {
    if (window.crypto && window.crypto.randomUUID) {
      return window.crypto.randomUUID();
    }
    return `batch-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  }

  function ensureLogItem(boothId, boothName) {
    if (!modal) return null;
    const existing = modal.logList.querySelector(`[data-booth="${boothId}"]`);
    if (existing) return existing;
    const item = document.createElement("li");
    item.dataset.booth = boothId;
    item.className = "flex flex-col gap-1 px-4 py-3";
    item.innerHTML = `
      <div class="flex items-center justify-between">
        <span class="font-semibold text-slate-800">${boothId}</span>
        <span data-status class="text-xs text-orange-600">待機中</span>
      </div>
      <div class="text-xs text-slate-500 truncate">${boothName || ""}</div>
      <div data-message class="text-xs text-slate-500"></div>
    `;
    modal.logList.appendChild(item);
    return item;
  }

  function updateLog(boothId, boothName, status, message, link) {
    const item = ensureLogItem(boothId, boothName);
    if (!item) return;
    const statusEl = item.querySelector("[data-status]");
    const messageEl = item.querySelector("[data-message]");
    if (statusEl) {
      statusEl.textContent = status;
      statusEl.className = "text-xs";
      if (status === "成功") {
        statusEl.classList.add("text-emerald-600");
      } else if (status === "失敗") {
        statusEl.classList.add("text-red-600");
      } else {
        statusEl.classList.add("text-orange-600");
      }
    }
    if (messageEl) {
      if (link) {
        messageEl.innerHTML = `
          <a href="${link}" target="_blank" rel="noopener" class="text-orange-600 underline">
            Google Drive で開く
          </a>
        `;
      } else {
        messageEl.textContent = message || "";
      }
    }
  }

  function updateProgress() {
    if (!modal || !state) return;
    const total = state.total || 0;
    const processed = state.processed || 0;
    modal.progress.total.textContent = String(total);
    modal.progress.count.textContent = String(processed);
    const ratio = total === 0 ? 0 : Math.min(processed / total, 1);
    modal.progress.bar.style.width = `${Math.round(ratio * 100)}%`;
    let label = "開始待ち";
    if (state.status === "running") {
      label = state.aborted ? "中断処理中" : "実行中";
    } else if (state.status === "completed") {
      label = "完了";
    } else if (state.status === "failed") {
      label = "一部失敗";
    }
    modal.progress.label.textContent = label;
  }

  function sanitizeFileName(text) {
    const normalized = (text || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036F]/g, "")
      .replace(/[^\x00-\x7F]/g, "")
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return normalized ? normalized.toLowerCase() : "booth";
  }

  function createFileName(boothId, boothName) {
    const safe = sanitizeFileName(boothName);
    return `Yatai_${boothId}_${safe}.png`;
  }

  async function startBatch() {
    if (!window.YataiQRBatch) {
      throw new Error("YataiQRBatch is not available");
    }
    const modalInstance = ensureModal();
    modalInstance.buttons.start.disabled = true;
    modalInstance.buttons.cancel.classList.remove("hidden");
    modalInstance.buttons.retry.classList.add("hidden");

    state.status = "running";
    state.processed = 0;
    state.successes = [];
    state.failures = [];
    state.aborted = false;
    updateProgress();

    let catalog;
    try {
      catalog = await loadCatalog();
      state.total = catalog.length;
      modal.totalLabel.textContent = String(state.total);
      modal.progress.total.textContent = String(state.total);
    } catch (error) {
      state.status = "failed";
      updateProgress();
      alert("屋台カタログの読み込みに失敗しました。");
      modal.buttons.start.disabled = false;
      modal.buttons.cancel.classList.add("hidden");
      return;
    }

    const itemsToProcess = state.failures.length
      ? state.failures.splice(0, state.failures.length)
      : catalog.slice();

    state.total = itemsToProcess.length;
    state.processed = 0;
    modal.totalLabel.textContent = String(state.total);
    modal.progress.total.textContent = String(state.total);
    updateProgress();

    modal.logList.innerHTML = "";
    for (const entry of itemsToProcess) {
      ensureLogItem(entry.boothId, entry.boothName);
    }

    for (let i = 0; i < itemsToProcess.length; i += CHUNK_SIZE) {
      if (state.aborted) break;
      const chunk = itemsToProcess.slice(i, i + CHUNK_SIZE);
      const payload = [];

      for (const entry of chunk) {
        if (state.aborted) break;
        updateLog(entry.boothId, entry.boothName, "生成中");
        try {
          const qr = await window.YataiQRBatch.generateQrData({
            boothId: entry.boothId,
            boothName: entry.boothName,
            size: DEFAULT_QR_SIZE
          });
          payload.push({
            boothId: qr.boothId,
            boothName: qr.boothName,
            fileName: createFileName(qr.boothId, qr.boothName),
            imageData: qr.dataUrl
          });
          updateLog(entry.boothId, entry.boothName, "アップロード待ち");
        } catch (error) {
          console.error(error);
          state.processed += 1;
          state.failures.push(entry);
          updateLog(entry.boothId, entry.boothName, "失敗", "QR生成に失敗しました");
          updateProgress();
        }
      }

      if (!payload.length) {
        continue;
      }

      if (state.aborted) {
        break;
      }

      try {
        const uploadResponse = await uploadItems(payload, state.batchId);
        const { results, folderLink } = uploadResponse;
        if (folderLink && modalInstance.meta) {
          const anchor = modalInstance.meta.querySelector("a");
          if (anchor) {
            anchor.href = folderLink;
          }
        }

        for (const result of results) {
          const catalogEntry = chunk.find(
            (entry) => entry.boothId === result.boothId
          );
          const boothName = catalogEntry ? catalogEntry.boothName : result.boothId;
          if (result.status === "success") {
            state.successes.push(result.boothId);
            state.processed += 1;
            updateLog(
              result.boothId,
              boothName,
              "成功",
              "",
              result.webViewLink || DRIVE_FOLDER_LINK
            );
          } else {
            state.failures.push({ boothId: result.boothId, boothName });
            state.processed += 1;
            updateLog(
              result.boothId,
              boothName,
              "失敗",
              result.errorMessage || "アップロードに失敗しました"
            );
          }
        }
        updateProgress();
      } catch (error) {
        console.error(error);
        for (const item of payload) {
          state.failures.push({ boothId: item.boothId, boothName: item.boothName });
          state.processed += 1;
          updateLog(
            item.boothId,
            item.boothName,
            "失敗",
            "サーバーエラーが発生しました"
          );
        }
        updateProgress();
      }
    }

    finalizeBatch();
  }

  async function retryFailures() {
    if (!state || !state.failures.length) return;
    const retryItems = state.failures.slice();
    state.failures = retryItems;
    state.batchId = createBatchId();
    await startBatch();
  }

  async function uploadItems(items, batchId) {
    const response = await fetch("/api/batch-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items, batchId })
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Upload failed: ${response.status} ${text}`);
    }
    return response.json();
  }

  function finalizeBatch() {
    if (!state || !modal) return;
    if (state.aborted) {
      state.status = "failed";
      updateProgress();
      modal.buttons.cancel.classList.add("hidden");
      modal.buttons.retry.classList.remove("hidden");
      modal.buttons.start.disabled = false;
      return;
    }

    const hasFailures = state.failures && state.failures.length > 0;
    state.status = hasFailures ? "failed" : "completed";
    updateProgress();
    modal.buttons.cancel.classList.add("hidden");
    modal.buttons.start.disabled = false;
    if (hasFailures) {
      modal.buttons.retry.classList.remove("hidden");
      modal.progress.label.textContent = "一部失敗";
    } else {
      modal.buttons.retry.classList.add("hidden");
      modal.progress.label.textContent = "完了";
    }
  }

  function handleKeydown(event) {
    if (matchesHotkey(event)) {
      event.preventDefault();
      openModal();
    }
  }

  document.addEventListener("keydown", handleKeydown, { capture: true });
})();
