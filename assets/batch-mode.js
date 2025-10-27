(function () {
  const DEFAULT_QR_SIZE = 300;
  const ZIP_FILENAME_PREFIX = "Yatai_QR_Batch";

  let catalogCache = null;
  let modal = null;
  let state = null;
  let triggerButton = null;

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
      <div><span class="font-semibold text-slate-700">出力形式:</span> ZIP（PNG画像をまとめてダウンロード）</div>
      <div class="text-xs text-slate-500">
        ※ ブラウザ上で生成したQRコード画像をZIPにまとめます。処理完了後にダウンロードボタンが表示されます。
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
      <a data-download class="btn-primary hidden" download>ZIPをダウンロード</a>
      <button type="button" data-start class="btn-primary">生成開始</button>
      <button type="button" data-retry class="btn-ghost hidden">再実行</button>
      <button type="button" data-cancel class="btn-ghost hidden">処理を中断</button>
      <button type="button" data-close class="btn-ghost">閉じる</button>
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
        download: footer.querySelector("[data-download]"),
        start: footer.querySelector("[data-start]"),
        retry: footer.querySelector("[data-retry]"),
        cancel: footer.querySelector("[data-cancel]"),
        close: footer.querySelector("[data-close]")
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
      if (!state) return;
      retryFailures().catch((error) => {
        console.error(error);
        alert("再実行に失敗しました。");
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
    if (triggerButton) {
      triggerButton.focus();
    }
  }

  function initializeState() {
    if (!modal) return;
    if (state && state.downloadUrl) {
      URL.revokeObjectURL(state.downloadUrl);
    }
    state = {
      status: "idle",
      total: 0,
      processed: 0,
      successes: [],
      failures: [],
      aborted: false,
      zip: null,
      downloadUrl: ""
    };
    modal.progress.label.textContent = "開始待ち";
    modal.progress.count.textContent = "0";
    modal.progress.total.textContent = "0";
    modal.progress.bar.style.width = "0%";
    modal.totalLabel.textContent = "0";
    modal.logList.innerHTML = "";
    modal.buttons.start.disabled = false;
    modal.buttons.start.textContent = "生成開始";
    modal.buttons.cancel.classList.add("hidden");
    modal.buttons.cancel.disabled = false;
    modal.buttons.cancel.textContent = "処理を中断";
    modal.buttons.retry.classList.add("hidden");
    resetDownloadLink();
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

  function updateLog(boothId, boothName, status, message) {
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
      messageEl.textContent = message || "";
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

  function resetDownloadLink() {
    if (!modal || !modal.buttons || !modal.buttons.download) return;
    const link = modal.buttons.download;
    link.classList.add("hidden");
    link.removeAttribute("href");
    link.removeAttribute("download");
    link.textContent = "ZIPをダウンロード";
    if (state && state.downloadUrl) {
      URL.revokeObjectURL(state.downloadUrl);
      state.downloadUrl = "";
    }
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

  function extractBase64(dataUrl) {
    if (typeof dataUrl !== "string") return "";
    const parts = dataUrl.split(",");
    return parts.length > 1 ? parts[1] : "";
  }

  function buildZipFileName(successCount) {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return `${ZIP_FILENAME_PREFIX}_${now.getFullYear()}${pad(
      now.getMonth() + 1
    )}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}_${String(
      successCount
    )}件.zip`;
  }

  async function prepareZipDownload() {
    if (!modal || !modal.buttons || !modal.buttons.download || !state || !state.zip) {
      return;
    }
    modal.progress.label.textContent = "ZIP作成中…";
    try {
      if (state.downloadUrl) {
        URL.revokeObjectURL(state.downloadUrl);
        state.downloadUrl = "";
      }
      const blob = await state.zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      state.downloadUrl = url;
      const filename = buildZipFileName(state.successes.length);
      const link = modal.buttons.download;
      link.href = url;
      link.download = filename;
      link.textContent = `ZIPをダウンロード（${state.successes.length}件）`;
      link.classList.remove("hidden");
    } catch (error) {
      console.error(error);
      alert("ZIPファイルの生成に失敗しました。");
      resetDownloadLink();
    }
  }

  async function startBatch(retryEntries) {
    if (!window.YataiQRBatch || typeof window.YataiQRBatch.generateQrData !== "function") {
      alert("一括生成に必要なモジュールが読み込まれていません。ページを再読み込みしてください。");
      return;
    }
    if (!window.JSZip) {
      alert("ZIP生成ライブラリの読み込みに失敗しました。ページを再読み込みしてください。");
      return;
    }

    const modalInstance = ensureModal();
    const isRetry = Array.isArray(retryEntries) && retryEntries.length > 0;

    modalInstance.buttons.start.disabled = true;
    modalInstance.buttons.start.textContent = "生成中…";
    modalInstance.buttons.cancel.classList.remove("hidden");
    modalInstance.buttons.cancel.disabled = false;
    modalInstance.buttons.cancel.textContent = "処理を中断";
    modalInstance.buttons.retry.classList.add("hidden");
    resetDownloadLink();

    state.status = "running";
    state.processed = 0;
    state.successes = [];
    state.failures = [];
    state.aborted = false;
    state.zip = new JSZip();
    updateProgress();

    let itemsToProcess = [];
    try {
      if (isRetry) {
        itemsToProcess = retryEntries.map((entry) => ({
          boothId: entry.boothId,
          boothName: entry.boothName || ""
        }));
      } else {
        const catalog = await loadCatalog();
        itemsToProcess = catalog.slice();
      }
    } catch (error) {
      console.error(error);
      state.status = "failed";
      updateProgress();
      alert("屋台カタログの読み込みに失敗しました。");
      modalInstance.buttons.start.disabled = false;
      modalInstance.buttons.start.textContent = "生成開始";
      modalInstance.buttons.cancel.classList.add("hidden");
      return;
    }

    state.total = itemsToProcess.length;
    state.processed = 0;
    modal.totalLabel.textContent = String(state.total);
    modal.progress.total.textContent = String(state.total);
    updateProgress();

    modal.logList.innerHTML = "";
    for (const entry of itemsToProcess) {
      ensureLogItem(entry.boothId, entry.boothName);
    }

    for (const entry of itemsToProcess) {
      if (state.aborted) break;
      updateLog(entry.boothId, entry.boothName, "生成中", "");
      try {
        const qr = await window.YataiQRBatch.generateQrData({
          boothId: entry.boothId,
          boothName: entry.boothName,
          size: DEFAULT_QR_SIZE
        });
        const base64Data = extractBase64(qr.dataUrl);
        if (!base64Data) {
          throw new Error("QRコードの変換に失敗しました");
        }
        state.zip.file(
          createFileName(qr.boothId, qr.boothName),
          base64Data,
          { base64: true }
        );
        state.successes.push(qr.boothId);
        state.processed += 1;
        updateLog(qr.boothId, qr.boothName, "成功", "ZIPへ追加済み");
      } catch (error) {
        console.error(error);
        state.failures.push({ boothId: entry.boothId, boothName: entry.boothName });
        state.processed += 1;
        updateLog(entry.boothId, entry.boothName, "失敗", "QR生成に失敗しました");
      }
      updateProgress();
    }

    await finalizeBatch();
  }

  async function retryFailures() {
    if (!state) return;
    await startBatch();
  }

  async function finalizeBatch() {
    if (!state || !modal) return;

    modal.buttons.cancel.classList.add("hidden");
    modal.buttons.start.disabled = false;

    const hasSuccess = state.successes.length > 0;
    const hasFailures = state.failures.length > 0;

    if (state.aborted) {
      state.status = "failed";
      updateProgress();
      modal.progress.label.textContent = hasSuccess ? "中断（部分生成）" : "中断";
      modal.buttons.retry.classList.remove("hidden");
      modal.buttons.start.textContent = "再実行";
      if (hasSuccess) {
        await prepareZipDownload();
      } else {
        resetDownloadLink();
      }
      return;
    }

    state.status = hasFailures ? "failed" : "completed";
    updateProgress();

    if (hasSuccess) {
      await prepareZipDownload();
    } else {
      resetDownloadLink();
    }

    if (hasFailures) {
      modal.progress.label.textContent = "一部失敗";
      modal.buttons.retry.classList.remove("hidden");
      modal.buttons.start.textContent = "再実行";
    } else {
      modal.progress.label.textContent = "完了";
      modal.buttons.retry.classList.add("hidden");
      modal.buttons.start.textContent = "もう一度生成";
    }
  }

  function setupTriggerButton() {
    triggerButton = document.getElementById("batch-trigger");
    if (!triggerButton) return;
    triggerButton.addEventListener("click", (event) => {
      event.preventDefault();
      openModal();
    });
  }

  setupTriggerButton();
})();
