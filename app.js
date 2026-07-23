(() => {
  "use strict";

  const GENRES = ["literary", "sci-fi", "fantasy", "mystery", "horror", "romance", "historical"];
  const LENGTH_BUCKETS = {
    short: (p) => p < 300,
    medium: (p) => p >= 300 && p <= 500,
    long: (p) => p > 500,
  };
  const SAVED_KEY = "novel-oracle:saved";
  const COVER_CACHE_KEY = "novel-oracle:cover-cache";

  const GREEK_LETTERS = [
    "Α", "Β", "Γ", "Δ", "Ε", "Ζ", "Η", "Θ", "Ι", "Κ", "Λ", "Μ",
    "Ν", "Ξ", "Ο", "Π", "Ρ", "Σ", "Τ", "Υ", "Φ", "Χ", "Ψ", "Ω",
  ];
  const FLICKER_INTERVAL_MS = 45;
  // Must track the .wl wave keyframe timing in styles.css: 600ms duration + (11 letters * 40ms delay).
  const WAVE_TOTAL_MS = 1040;

  /** @type {Array<object>} */
  let ALL_BOOKS = [];
  /** @type {Array<string>} shuffled ids not yet shown this "deck" */
  let deck = [];
  let lastShownId = null;
  let currentBook = null;
  let coverCache = loadCoverCache();

  const state = {
    genres: new Set(),
    decadeFrom: null,
    decadeTo: null,
    length: "any",
  };

  // ---------- pure logic (exported for testing under Node) ----------

  function fisherYatesShuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function matchesFilters(book, filters) {
    if (filters.genres && filters.genres.size > 0) {
      const hasGenre = book.genres.some((g) => filters.genres.has(g));
      if (!hasGenre) return false;
    }
    if (filters.decadeFrom != null) {
      const decade = Math.floor(book.year / 10) * 10;
      if (decade < filters.decadeFrom) return false;
    }
    if (filters.decadeTo != null) {
      const decade = Math.floor(book.year / 10) * 10;
      if (decade > filters.decadeTo) return false;
    }
    if (filters.length && filters.length !== "any") {
      const test = LENGTH_BUCKETS[filters.length];
      if (test && !test(book.pages)) return false;
    }
    return true;
  }

  function filterPool(books, filters) {
    return books.filter((b) => matchesFilters(b, filters));
  }

  /**
   * Draws the next book id from a no-repeat-until-exhausted deck.
   * Mutates and returns { deck, pickedId } given the current deck and full pool ids.
   * When the deck is empty, reshuffles from poolIds, avoiding an immediate repeat
   * of lastId when the pool has more than one book.
   */
  function drawNext(currentDeck, poolIds, lastId) {
    let deck = currentDeck;
    if (deck.length === 0) {
      deck = fisherYatesShuffle(poolIds);
      if (deck.length > 1 && deck[0] === lastId) {
        // swap first pick away from an immediate repeat
        const swapWith = 1 + Math.floor(Math.random() * (deck.length - 1));
        [deck[0], deck[swapWith]] = [deck[swapWith], deck[0]];
      }
    }
    const pickedId = deck.shift();
    return { deck, pickedId };
  }

  function loadCoverCache() {
    try {
      const raw = localStorage.getItem(COVER_CACHE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function saveCoverCache() {
    try {
      localStorage.setItem(COVER_CACHE_KEY, JSON.stringify(coverCache));
    } catch {
      /* storage unavailable or full — cover cache is best-effort */
    }
  }

  function loadSaved() {
    try {
      const raw = localStorage.getItem(SAVED_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function saveSaved(ids) {
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify(ids));
    } catch {
      /* storage unavailable or full */
    }
  }

  // Expose pure functions for the Node smoke test harness.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { fisherYatesShuffle, matchesFilters, filterPool, drawNext, GENRES, LENGTH_BUCKETS };
  }

  // ---------- DOM wiring (browser only) ----------
  if (typeof window === "undefined" || typeof document === "undefined") return;

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    wireBrandMark();
    try {
      const res = await fetch("books.json");
      if (!res.ok) throw new Error("bad response");
      ALL_BOOKS = await res.json();
    } catch (err) {
      showFatalError();
      return;
    }

    buildGenreFilters();
    buildDecadeFilters();
    wireControls();
    renderSavedPanel();

    const hashId = getBookIdFromHash();
    if (hashId) {
      const book = ALL_BOOKS.find((b) => b.id === hashId);
      if (book) {
        currentBook = book;
        lastShownId = book.id;
        renderBook(book, { animate: false });
      } else {
        rollNext({ animate: false });
      }
    } else {
      rollNext({ animate: false });
    }

    window.addEventListener("hashchange", () => {
      const id = getBookIdFromHash();
      if (id && ALL_BOOKS.length) {
        const book = ALL_BOOKS.find((b) => b.id === id);
        if (book) {
          currentBook = book;
          renderBook(book, { animate: true });
        }
      }
    });
  }

  function wireBrandMark() {
    const mark = document.getElementById("brand-mark");
    const brand = document.querySelector(".brand");
    if (!mark || !brand) return;

    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let flickerTimer = null;
    let settleTimer = null;

    function randomLetter(exclude) {
      let letter;
      do {
        letter = GREEK_LETTERS[Math.floor(Math.random() * GREEK_LETTERS.length)];
      } while (letter === exclude && GREEK_LETTERS.length > 1);
      return letter;
    }

    function stopTimers() {
      if (flickerTimer) { window.clearInterval(flickerTimer); flickerTimer = null; }
      if (settleTimer) { window.clearTimeout(settleTimer); settleTimer = null; }
    }

    mark.textContent = randomLetter();

    brand.addEventListener("mouseenter", () => {
      stopTimers();
      if (prefersReduced) {
        mark.textContent = randomLetter(mark.textContent);
        return;
      }
      flickerTimer = window.setInterval(() => {
        mark.textContent = randomLetter(mark.textContent);
      }, FLICKER_INTERVAL_MS);
      settleTimer = window.setTimeout(() => {
        stopTimers();
        mark.textContent = randomLetter(mark.textContent);
      }, WAVE_TOTAL_MS);
    });

    brand.addEventListener("mouseleave", () => {
      if (flickerTimer) {
        stopTimers();
        mark.textContent = randomLetter(mark.textContent);
      }
    });
  }

  function showFatalError() {
    const stage = document.getElementById("stage");
    stage.innerHTML = `
      <div class="empty-state" role="alert">
        <p class="empty-state__title">The shelves are unreachable.</p>
        <p class="empty-state__body">books.json could not be loaded. If you opened this file directly, try serving the folder with a local static server instead.</p>
      </div>`;
    const surpriseBtn = document.getElementById("surprise-btn");
    const anotherBtn = document.getElementById("another-btn");
    if (surpriseBtn) surpriseBtn.disabled = true;
    if (anotherBtn) anotherBtn.disabled = true;
  }

  function getBookIdFromHash() {
    const m = /^#\/book\/(.+)$/.exec(location.hash);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function currentFilters() {
    return {
      genres: state.genres,
      decadeFrom: state.decadeFrom,
      decadeTo: state.decadeTo,
      length: state.length,
    };
  }

  function resetDeck() {
    const pool = filterPool(ALL_BOOKS, currentFilters());
    deck = fisherYatesShuffle(pool.map((b) => b.id));
    return pool;
  }

  function buildGenreFilters() {
    const container = document.getElementById("genre-filters");
    container.innerHTML = "";
    GENRES.forEach((g) => {
      const id = `genre-${g}`;
      const label = document.createElement("label");
      label.className = "chip";
      label.setAttribute("for", id);
      label.innerHTML = `
        <input type="checkbox" id="${id}" value="${g}" />
        <span>${genreLabel(g)}</span>`;
      container.appendChild(label);
      label.querySelector("input").addEventListener("change", (e) => {
        if (e.target.checked) state.genres.add(g);
        else state.genres.delete(g);
        onFiltersChanged();
      });
    });
  }

  function genreLabel(g) {
    if (g === "sci-fi") return "Sci-Fi";
    return g.charAt(0).toUpperCase() + g.slice(1);
  }

  function buildDecadeFilters() {
    const years = ALL_BOOKS.map((b) => b.year);
    const minDecade = Math.floor(Math.min(...years) / 10) * 10;
    const maxDecade = Math.floor(Math.max(...years) / 10) * 10;
    const fromSel = document.getElementById("decade-from");
    const toSel = document.getElementById("decade-to");
    fromSel.innerHTML = "";
    toSel.innerHTML = "";

    const anyFromOpt = new Option("Any era", "");
    const anyToOpt = new Option("Any era", "");
    fromSel.appendChild(anyFromOpt);
    toSel.appendChild(anyToOpt);

    for (let d = minDecade; d <= maxDecade; d += 10) {
      fromSel.appendChild(new Option(`${d}s`, String(d)));
      toSel.appendChild(new Option(`${d}s`, String(d)));
    }

    fromSel.addEventListener("change", () => {
      state.decadeFrom = fromSel.value ? Number(fromSel.value) : null;
      onFiltersChanged();
    });
    toSel.addEventListener("change", () => {
      state.decadeTo = toSel.value ? Number(toSel.value) : null;
      onFiltersChanged();
    });
  }

  function wireControls() {
    document.getElementById("surprise-btn").addEventListener("click", () => rollNext({ animate: true }));
    document.getElementById("another-btn").addEventListener("click", () => rollNext({ animate: true }));
    document.getElementById("reset-filters-btn").addEventListener("click", resetFilters);

    document.querySelectorAll('input[name="length"]').forEach((el) => {
      el.addEventListener("change", () => {
        state.length = el.value;
        onFiltersChanged();
      });
    });

    document.getElementById("save-btn").addEventListener("click", toggleSaveCurrent);
    document.getElementById("copy-link-btn").addEventListener("click", copyPermalink);
    document.getElementById("saved-toggle-btn").addEventListener("click", () => {
      document.getElementById("saved-panel").classList.toggle("is-open");
    });
    document.getElementById("saved-close-btn").addEventListener("click", () => {
      document.getElementById("saved-panel").classList.remove("is-open");
    });
  }

  function resetFilters() {
    state.genres.clear();
    state.decadeFrom = null;
    state.decadeTo = null;
    state.length = "any";
    document.querySelectorAll("#genre-filters input").forEach((i) => (i.checked = false));
    document.getElementById("decade-from").value = "";
    document.getElementById("decade-to").value = "";
    document.querySelectorAll('input[name="length"]').forEach((i) => (i.checked = i.value === "any"));
    onFiltersChanged();
  }

  function onFiltersChanged() {
    deck = [];
    rollNext({ animate: true });
  }

  function rollNext(opts = {}) {
    const pool = filterPool(ALL_BOOKS, currentFilters());
    const emptyState = document.getElementById("empty-state");
    const stage = document.getElementById("stage");

    if (pool.length === 0) {
      deck = [];
      currentBook = null;
      stage.hidden = true;
      emptyState.hidden = false;
      document.getElementById("another-btn").disabled = true;
      document.getElementById("surprise-btn").disabled = true;
      return;
    }

    emptyState.hidden = true;
    stage.hidden = false;
    document.getElementById("another-btn").disabled = false;
    document.getElementById("surprise-btn").disabled = false;

    const poolIds = pool.map((b) => b.id);
    // If the deck holds ids no longer in the active pool (filters just changed), drop them.
    deck = deck.filter((id) => poolIds.includes(id));

    const draw = drawNext(deck, poolIds, lastShownId);
    deck = draw.deck;
    const book = ALL_BOOKS.find((b) => b.id === draw.pickedId);
    lastShownId = book.id;
    currentBook = book;

    setHash(book.id);
    renderBook(book, opts);
  }

  function setHash(id) {
    const newHash = `#/book/${encodeURIComponent(id)}`;
    if (location.hash !== newHash) {
      history.replaceState(null, "", newHash);
    }
  }

  const FLASHCARD_COUNT = 5; // quick flashes shown before settling on the real pick
  const FLASHCARD_INTERVAL_MS = 80;

  function paintFrame(book, { withFallbackCover = true } = {}) {
    document.getElementById("book-title").textContent = book.title;
    document.getElementById("book-author").textContent = book.author;
    document.getElementById("book-year").textContent = book.year;
    document.getElementById("book-pages").textContent = `${book.pages} pages`;
    document.getElementById("book-synopsis").textContent = book.synopsis;

    const tagsEl = document.getElementById("book-genres");
    tagsEl.innerHTML = "";
    book.genres.forEach((g) => {
      const tag = document.createElement("li");
      tag.className = `tag tag--${g}`;
      tag.textContent = genreLabel(g);
      tagsEl.appendChild(tag);
    });

    if (withFallbackCover) {
      const wrap = document.getElementById("cover-wrap");
      wrap.classList.add("cover-wrap--fallback");
      wrap.innerHTML = fallbackCoverMarkup(book);
    }
  }

  function fallbackCoverMarkup(book) {
    return `
      <div class="cover-fallback">
        <span class="cover-fallback__title">${escapeHtml(book.title)}</span>
        <span class="cover-fallback__author">${escapeHtml(book.author)}</span>
      </div>`;
  }

  function renderBook(book, { animate = true } = {}) {
    const card = document.getElementById("book-card");
    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    function settle() {
      paintFrame(book, { withFallbackCover: false });
      updateSaveButton(book.id);
      renderCover(book);
      card.classList.add("is-settling");
      window.setTimeout(() => card.classList.remove("is-settling"), 280);
    }

    if (!animate || prefersReduced) {
      paintFrame(book, { withFallbackCover: false });
      updateSaveButton(book.id);
      renderCover(book);
      return;
    }

    const pool = filterPool(ALL_BOOKS, currentFilters());
    const candidates = pool.length > 1 ? pool : ALL_BOOKS;

    card.classList.add("is-flashing");
    let shown = 0;
    let lastFlashId = null;
    const timer = window.setInterval(() => {
      shown++;
      if (shown > FLASHCARD_COUNT) {
        window.clearInterval(timer);
        card.classList.remove("is-flashing");
        settle();
        return;
      }
      let flash;
      do {
        flash = candidates[Math.floor(Math.random() * candidates.length)];
      } while (flash.id === lastFlashId && candidates.length > 1);
      lastFlashId = flash.id;
      paintFrame(flash);
    }, FLASHCARD_INTERVAL_MS);
  }

  function renderCover(book) {
    const wrap = document.getElementById("cover-wrap");
    wrap.innerHTML = "";
    wrap.classList.remove("cover-wrap--fallback");

    const fallback = () => {
      wrap.classList.add("cover-wrap--fallback");
      wrap.innerHTML = fallbackCoverMarkup(book);
    };

    const cached = coverCache[book.id];
    if (cached === null) {
      fallback();
      return;
    }
    if (cached) {
      mountCoverImg(wrap, cached, fallback);
      return;
    }
    if (book.coverUrl) {
      mountCoverImg(wrap, book.coverUrl, fallback);
      return;
    }

    fallback();
    fetchCoverFromOpenLibrary(book).then((url) => {
      // Only apply if we're still looking at the same book.
      if (!currentBook || currentBook.id !== book.id) return;
      if (url) {
        coverCache[book.id] = url;
        saveCoverCache();
        mountCoverImg(wrap, url, fallback);
      } else {
        coverCache[book.id] = null;
        saveCoverCache();
      }
    });
  }

  function mountCoverImg(wrap, src, onFail) {
    wrap.classList.remove("cover-wrap--fallback");
    const img = new Image();
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.onload = () => {
      if (img.naturalWidth < 10 || img.naturalHeight < 10) {
        onFail();
      } else {
        wrap.innerHTML = "";
        wrap.appendChild(img);
      }
    };
    img.onerror = onFail;
    img.src = src;
  }

  async function fetchCoverFromOpenLibrary(book) {
    try {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 4000);
      const params = new URLSearchParams({
        title: book.title,
        author: book.author,
        limit: "1",
        fields: "cover_i",
      });
      const res = await fetch(`https://openlibrary.org/search.json?${params}`, { signal: controller.signal });
      window.clearTimeout(timeout);
      if (!res.ok) return null;
      const data = await res.json();
      const coverId = data && data.docs && data.docs[0] && data.docs[0].cover_i;
      if (!coverId) return null;
      return `https://covers.openlibrary.org/b/id/${coverId}-M.jpg`;
    } catch {
      return null;
    }
  }

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function updateSaveButton(id) {
    const saved = loadSaved();
    const btn = document.getElementById("save-btn");
    const isSaved = saved.includes(id);
    btn.setAttribute("aria-pressed", String(isSaved));
    btn.textContent = isSaved ? "Saved ✓" : "Save to list";
  }

  function toggleSaveCurrent() {
    if (!currentBook) return;
    const saved = loadSaved();
    const idx = saved.indexOf(currentBook.id);
    if (idx === -1) saved.push(currentBook.id);
    else saved.splice(idx, 1);
    saveSaved(saved);
    updateSaveButton(currentBook.id);
    renderSavedPanel();
  }

  function renderSavedPanel() {
    const list = document.getElementById("saved-list");
    const saved = loadSaved();
    const countEl = document.getElementById("saved-count");
    countEl.textContent = String(saved.length);
    list.innerHTML = "";

    if (saved.length === 0) {
      list.innerHTML = `<li class="saved-empty">Nothing saved yet — books you save will collect here.</li>`;
      return;
    }

    saved.forEach((id) => {
      const book = ALL_BOOKS.find((b) => b.id === id);
      if (!book) return;
      const li = document.createElement("li");
      li.className = "saved-item";
      li.innerHTML = `
        <button type="button" class="saved-item__link">${escapeHtml(book.title)} <span>— ${escapeHtml(book.author)}</span></button>
        <button type="button" class="saved-item__remove" aria-label="Remove ${escapeHtml(book.title)} from saved list">✕</button>`;
      li.querySelector(".saved-item__link").addEventListener("click", () => {
        currentBook = book;
        setHash(book.id);
        renderBook(book, { animate: true });
        document.getElementById("saved-panel").classList.remove("is-open");
      });
      li.querySelector(".saved-item__remove").addEventListener("click", () => {
        const remaining = loadSaved().filter((x) => x !== id);
        saveSaved(remaining);
        renderSavedPanel();
        if (currentBook && currentBook.id === id) updateSaveButton(id);
      });
      list.appendChild(li);
    });
  }

  function copyPermalink() {
    const url = location.href;
    const btn = document.getElementById("copy-link-btn");
    const done = () => {
      const original = btn.textContent;
      btn.textContent = "Copied!";
      window.setTimeout(() => (btn.textContent = original), 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(done);
    } else {
      done();
    }
  }
})();
