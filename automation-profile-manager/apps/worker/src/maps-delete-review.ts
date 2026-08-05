/**
 * Xóa bài đánh giá Google Maps đã đăng (đúng session account).
 * Mọi browser eval dùng evalSafe (string) — tránh tsx inject `__name`.
 *
 * Quy tắc: chỉ trả ok:true khi đã verify bài biến mất (hoặc trang báo đã xóa).
 * Không “coi như đã xóa” khi thiếu dialog / thiếu bằng chứng.
 */
import type { Page } from "puppeteer";
import type { MapsDeleteReviewPayload } from "@apm/shared";
import { HumanCursor } from "./humanize.js";
import { evalSafe } from "./maps-eval.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type DeleteMapsReviewResult = {
  ok: boolean;
  alreadyGone: boolean;
  detail: string;
};

function snippetOf(text: string | null | undefined, n = 48): string {
  return (text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n)
    .toLowerCase();
}

function isContribReviewsUrl(url: string): boolean {
  return /\/maps\/contrib\/\d+\/reviews\/?(\?|$)/i.test(url);
}

function isLikelySpecificReviewUrl(url: string): boolean {
  if (!url.trim()) return false;
  if (isContribReviewsUrl(url)) return false;
  return /maps\.app\.goo\.gl|goo\.gl\/maps|\/maps\/reviews|review\/data|!1s|cid=/i.test(
    url,
  );
}

async function pageSaysDeleted(page: Page): Promise<boolean> {
  return Boolean(
    await evalSafe<boolean>(
      page,
      `var body = (document.body && document.body.innerText || "").toLowerCase();
       return /bài đánh giá này không còn|this review is no longer available|review has been removed|đã bị xóa|no longer available/i.test(body);`,
    ),
  );
}

async function confirmDeleteDialog(page: Page): Promise<boolean> {
  for (let i = 0; i < 14; i++) {
    const ok = await evalSafe<boolean>(
      page,
      `function clickEl(el) {
         try {
           el.scrollIntoView({ block: "center", inline: "nearest" });
           el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
           el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
           el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
           if (typeof el.click === "function") el.click();
           return true;
         } catch (e) { return false; }
       }
       function labelOf(el) {
         return ((el.innerText || el.textContent || el.getAttribute("aria-label") || "") + "")
           .replace(/\\s+/g, " ").trim().toLowerCase();
       }
       var roots = Array.prototype.slice.call(document.querySelectorAll(
         '[role="dialog"], [aria-modal="true"], div[aria-label*="Delete" i], div[aria-label*="Xóa" i], div[aria-label*="xóa" i]'
       ));
       if (!roots.length) roots = [document.body];
       else roots.push(document.body);

       for (var r = 0; r < roots.length; r++) {
         var buttons = Array.prototype.slice.call(roots[r].querySelectorAll("button, [role='button'], div[role='button']"));
         var ranked = [];
         for (var b = 0; b < buttons.length; b++) {
           var el = buttons[b];
           var t = labelOf(el);
           var id = ((el.getAttribute("data-id") || "") + "").toLowerCase();
           var jsname = ((el.getAttribute("jsname") || "") + "").toLowerCase();
           if (!t && !id) continue;
           if (/hủy|cancel|đóng|close|dismiss|không/i.test(t)) continue;
           var score = 0;
           if (id === "confirm") score += 50;
           if (/confirm/i.test(jsname)) score += 40;
           if (/^(xóa|delete)$/i.test(t)) score += 40;
           if (/xóa bài|delete review|delete this|xóa đánh giá/i.test(t)) score += 35;
           if (/\\bxóa\\b|\\bdelete\\b/i.test(t)) score += 20;
           if (/đồng ý|yes|ok|có$/i.test(t)) score += 10;
           if (score > 0) ranked.push({ el: el, score: score, t: t });
         }
         ranked.sort(function(a, b) { return b.score - a.score; });
         if (ranked.length && clickEl(ranked[0].el)) return true;

         var dlg = roots[r].querySelector
           ? roots[r].querySelector('[aria-label*="Delete" i], [aria-label*="Xóa" i]')
           : null;
         if (dlg) {
           var dBtns = Array.prototype.slice.call(dlg.querySelectorAll("button"));
           if (dBtns.length >= 2 && clickEl(dBtns[dBtns.length - 1])) return true;
         }
       }
       return false;`,
    );
    if (ok) return true;
    await sleep(300);
  }
  return false;
}

async function clickDeleteMenuItem(page: Page): Promise<boolean> {
  await sleep(500);
  const hit = await evalSafe<{ ok: boolean; labels: string[] }>(
    page,
    `function clickEl(el) {
       try {
         el.scrollIntoView({ block: "center", inline: "nearest" });
         el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
         el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
         el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
         if (typeof el.click === "function") el.click();
         return true;
       } catch (e) { return false; }
     }
     function labelOf(el) {
       return ((el.innerText || el.textContent || el.getAttribute("aria-label") || "") + "")
         .replace(/\\s+/g, " ").trim();
     }
     var sel = [
       '[role="menuitem"]',
       '[role="menuitemradio"]',
       '[role="option"]',
       'div[role="menu"] [role="menuitem"]',
       'div[role="menu"] [role="menuitemradio"]',
       'ul[role="menu"] li',
       '[jsaction*="pane.wfvdle"]',
       '[jsaction*="review.delete"]'
     ].join(",");
     var items = Array.prototype.slice.call(document.querySelectorAll(sel));
     var menus = Array.prototype.slice.call(document.querySelectorAll('[role="menu"], [role="listbox"]'));
     for (var m = 0; m < menus.length; m++) {
       var extra = Array.prototype.slice.call(menus[m].querySelectorAll("div, span, li, button"));
       for (var e = 0; e < extra.length; e++) {
         if (items.indexOf(extra[e]) < 0) items.push(extra[e]);
       }
     }
     var labels = [];
     var candidates = [];
     for (var i = 0; i < items.length; i++) {
       var t = labelOf(items[i]);
       if (!t || t.length > 80) continue;
       labels.push(t);
       var low = t.toLowerCase();
       if (/chỉnh sửa|edit review|edit$|chia sẻ|share|báo cáo|report|flag|ảnh|photo|add a photo|like|thích/i.test(low)) continue;
       var score = 0;
       if (/^xóa bài đánh giá$|^delete review$/i.test(low)) score = 100;
       else if (/xóa bài|delete review|remove review/i.test(low)) score = 90;
       else if (/^xóa$|^delete$/i.test(low)) score = 80;
       else if (/\\bxóa\\b|\\bdelete\\b/i.test(low)) score = 60;
       if (score > 0) candidates.push({ el: items[i], score: score, t: t });
     }
     candidates.sort(function(a, b) { return b.score - a.score; });
     if (candidates.length && clickEl(candidates[0].el)) {
       return { ok: true, labels: labels.slice(0, 12) };
     }
     // Không fallback data-index=1 — dễ bấm nhầm Edit/Share
     return { ok: false, labels: labels.slice(0, 12) };`,
  );
  if (!hit?.ok) {
    console.warn(
      `[maps-delete] không thấy item Xóa trong menu. labels=${JSON.stringify(hit?.labels || [])}`,
    );
  }
  return Boolean(hit?.ok);
}

async function deleteFromOpenedMenu(page: Page): Promise<{
  ok: boolean;
  step: "menu" | "confirm" | "ok";
}> {
  if (!(await clickDeleteMenuItem(page))) {
    await page.keyboard.press("Escape").catch(() => undefined);
    return { ok: false, step: "menu" };
  }
  await sleep(700);
  if (!(await confirmDeleteDialog(page))) {
    // Trước đây: coi như đã xóa → báo thành công giả. Giờ bắt buộc có confirm.
    console.warn(
      "[maps-delete] không thấy dialog confirm — không đánh dấu đã xóa",
    );
    await page.keyboard.press("Escape").catch(() => undefined);
    return { ok: false, step: "confirm" };
  }
  return { ok: true, step: "ok" };
}

async function tryDeleteViaActionMenu(page: Page): Promise<boolean> {
  const opened = await evalSafe<boolean>(
    page,
    `var buttons = Array.prototype.slice.call(document.querySelectorAll("button"));
     for (var i = 0; i < buttons.length; i++) {
       var b = buttons[i];
       var js = b.getAttribute("jsaction") || "";
       var al = ((b.getAttribute("aria-label") || "") + "").toLowerCase();
       if (b.getAttribute("aria-hidden") === "true") continue;
       // Chỉ menu action của review — tránh nút menu sidebar / photo
       if (/review\\.actionMenu|pane\\.wfvdle|moreActions/i.test(js)) { b.click(); return true; }
       if (/^actions for |^tùy chọn |thêm tùy chọn|more options for|more actions/i.test(al)) {
         b.click(); return true;
       }
     }
     return false;`,
  );
  if (!opened) return false;
  const r = await deleteFromOpenedMenu(page);
  return r.ok;
}

async function openReviewsTab(page: Page) {
  await evalSafe(
    page,
    `var tabs = Array.prototype.slice.call(document.querySelectorAll('button[role="tab"], button'));
     for (var i = 0; i < tabs.length; i++) {
       var label = ((tabs[i].textContent || tabs[i].getAttribute("aria-label") || "") + "").trim();
       if (/bài đánh giá|reviews?/i.test(label)) { tabs[i].click(); return; }
     }`,
  ).catch(() => undefined);
  await sleep(800);
}

async function bodyHasSnippet(page: Page, snippet: string): Promise<boolean> {
  if (snippet.length < 10) return false;
  return Boolean(
    await evalSafe<boolean>(
      page,
      `var sn = String(a0 || "").slice(0, 36).toLowerCase();
       var body = ((document.body && document.body.innerText) || "").toLowerCase();
       return body.indexOf(sn) >= 0;`,
      snippet,
    ),
  );
}

async function deleteOnContribReviewsPage(
  page: Page,
  snippet: string,
): Promise<{ ok: boolean; detail: string }> {
  await sleep(1200);

  const opened = await evalSafe<{ opened: boolean; matched: boolean }>(
    page,
    `var snip = a0 || "";
     var sn = String(snip).slice(0, 40).toLowerCase();
     function norm(s) { return (s || "").replace(/\\s+/g, " ").trim().toLowerCase(); }
     var actionBtns = Array.prototype.slice.call(document.querySelectorAll("button[aria-label]")).filter(function(b) {
       var al = ((b.getAttribute("aria-label") || "") + "").toLowerCase();
       return al.indexOf("actions for") === 0 || al.indexOf("tùy chọn") === 0 || /more options|thêm tùy chọn/i.test(al);
     });
     if (sn.length >= 8) {
       var cards = Array.prototype.slice.call(document.querySelectorAll("div.jftiEf, div[data-review-id], div[jsaction*='review'], div.section-review"));
       for (var c = 0; c < cards.length; c++) {
         if (norm(cards[c].innerText).indexOf(sn.slice(0, 28)) < 0) continue;
         var btn = cards[c].querySelector('button[jsaction*="review.actionMenu"], button[aria-label*="Actions" i], button[aria-label*="Tùy chọn" i]');
         if (!btn) {
           for (var a = 0; a < actionBtns.length; a++) {
             if (cards[c].contains(actionBtns[a])) { btn = actionBtns[a]; break; }
           }
         }
         if (btn) { btn.click(); return { opened: true, matched: true }; }
       }
     }
     // Không bấm actionBtns[0] mù — dễ xóa nhầm / báo giả
     var legacy = document.querySelector('button[jsaction*="review.actionMenu"]');
     if (legacy && sn.length < 8) { legacy.click(); return { opened: true, matched: false }; }
     return { opened: false, matched: false };`,
    snippet,
  );

  if (!opened?.opened) {
    return { ok: false, detail: "Không tìm thấy menu xóa trên trang contrib" };
  }

  const deleted = await deleteFromOpenedMenu(page);
  if (!deleted.ok) {
    return {
      ok: false,
      detail:
        deleted.step === "menu"
          ? "Mở menu trên contrib nhưng không thấy mục Xóa"
          : "Mở menu trên contrib nhưng không bấm được Confirm",
    };
  }

  await sleep(2200);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(
    () => undefined,
  );
  await sleep(1200);

  if (snippet.length >= 10) {
    const still = await evalSafe<boolean>(
      page,
      `var sn = String(a0 || "").slice(0, 36).toLowerCase();
       var cards = Array.prototype.slice.call(document.querySelectorAll("div.jftiEf, div[data-review-id], div[jsaction*='review']"));
       for (var i = 0; i < cards.length; i++) {
         if (((cards[i].innerText || "") + "").toLowerCase().indexOf(sn) >= 0) return true;
       }
       if (cards.length === 0) {
         return ((document.body && document.body.innerText || "") + "").toLowerCase().indexOf(sn) >= 0;
       }
       return false;`,
      snippet,
    );
    if (still) {
      return {
        ok: false,
        detail: "Đã confirm xóa trên contrib nhưng bài vẫn còn trong danh sách",
      };
    }
  } else {
    // Không có snippet đủ dài → bắt buộc trang trống / không còn menu action
    const stillHas = await evalSafe<boolean>(
      page,
      `return Boolean(document.querySelector('button[jsaction*="review.actionMenu"], button[aria-label*="Actions for" i], button[aria-label*="Tùy chọn" i]'));`,
    );
    if (stillHas) {
      return {
        ok: false,
        detail: "Đã confirm trên contrib nhưng vẫn còn menu review — chưa chắc đã xóa",
      };
    }
  }

  return {
    ok: true,
    detail: opened.matched
      ? "Đã xóa trên trang contrib (khớp nội dung)"
      : "Đã xóa trên trang contrib",
  };
}

async function ownReviewStillOnPlace(
  page: Page,
  snippet: string,
): Promise<boolean> {
  return Boolean(
    await evalSafe<boolean>(
      page,
      `var sn = String(a0 || "").slice(0, 32).toLowerCase();
       var ownHints = /your review|bài đánh giá của bạn|đánh giá của bạn/i;
       var blocks = Array.prototype.slice.call(document.querySelectorAll("div.jftiEf, div[data-review-id], div[jsaction*='review'], div.fontBodyMedium, div.MyEned"));
       for (var i = 0; i < blocks.length; i++) {
         var t = ((blocks[i].textContent || "") + "").toLowerCase();
         if (!ownHints.test(t)) continue;
         if (sn.length >= 8) return t.indexOf(sn) >= 0;
         return true;
       }
       var body = ((document.body && document.body.innerText) || "").toLowerCase();
       if (ownHints.test(body)) {
         if (sn.length >= 8) return body.indexOf(sn) >= 0;
         return true;
       }
       return false;`,
      snippet,
    ),
  );
}

async function deleteOwnReviewOnPlace(
  page: Page,
  snippet: string,
): Promise<{ ok: boolean; detail: string }> {
  await openReviewsTab(page);
  await sleep(700);

  const opened = await evalSafe<boolean>(
    page,
    `var sn = String(a0 || "").slice(0, 36).toLowerCase();
     var ownHints = /your review|bài đánh giá của bạn|đánh giá của bạn/i;
     var blocks = Array.prototype.slice.call(document.querySelectorAll("div.jftiEf, div[data-review-id], div[jsaction*='review'], div.MyEned"));
     var target = null;
     for (var i = 0; i < blocks.length; i++) {
       var t = ((blocks[i].textContent || "") + "").toLowerCase();
       if (ownHints.test(t)) { target = blocks[i]; break; }
     }
     if (!target && sn.length >= 8) {
       for (var j = 0; j < blocks.length; j++) {
         if (((blocks[j].textContent || "") + "").toLowerCase().indexOf(sn.slice(0, 28)) >= 0) {
           target = blocks[j];
           break;
         }
       }
     }
     if (!target) return false;
     var menu = target.querySelector('button[jsaction*="review.actionMenu"], button[aria-label*="Actions" i], button[aria-label*="Tùy chọn" i], button[aria-label*="More" i]');
     if (!menu) return false;
     menu.click();
     return true;`,
    snippet,
  );

  if (!opened) {
    return { ok: false, detail: "Không thấy khối review của bạn trên place" };
  }

  const deleted = await deleteFromOpenedMenu(page);
  if (!deleted.ok) {
    return {
      ok: false,
      detail:
        deleted.step === "menu"
          ? "Mở menu trên place nhưng không thấy mục Xóa (Edit/Share…)"
          : "Mở menu trên place nhưng không bấm được Confirm",
    };
  }

  await sleep(2500);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(
    () => undefined,
  );
  await sleep(1000);
  await openReviewsTab(page);
  await sleep(700);

  if (await ownReviewStillOnPlace(page, snippet)) {
    return {
      ok: false,
      detail: "Đã confirm xóa nhưng khối review của bạn vẫn còn trên place",
    };
  }
  if (snippet.length >= 10 && (await bodyHasSnippet(page, snippet))) {
    // Có thể còn trong list review công khai — chưa chắc đã xóa
    return {
      ok: false,
      detail: "Đã confirm xóa nhưng nội dung bài vẫn còn trên trang địa điểm",
    };
  }

  return {
    ok: true,
    detail: "Đã xóa qua trang địa điểm (không còn review của bạn)",
  };
}

export async function deleteMapsReview(
  page: Page,
  payload: MapsDeleteReviewPayload,
  opts?: { signal?: AbortSignal; human?: HumanCursor },
): Promise<DeleteMapsReviewResult> {
  const human = opts?.human ?? new HumanCursor(page);
  const snippet = snippetOf(payload.reviewText);
  const throwIfAborted = () => {
    if (opts?.signal?.aborted) {
      throw new Error("MAPS_DELETE_REVIEW aborted (timeout/cancel)");
    }
  };

  const link = payload.reviewLink?.trim() || "";
  const failures: string[] = [];

  // A) Contrib reviews list
  if (link && isContribReviewsUrl(link)) {
    throwIfAborted();
    console.log(`[maps-delete] goto contrib reviews ${link.slice(0, 100)}`);
    await page.goto(link, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await sleep(1000);
    await human.pause(200, 400);

    const empty = await evalSafe<boolean>(
      page,
      `var body = ((document.body && document.body.innerText) || "").toLowerCase();
       if (/chưa có bài đánh giá|no reviews|you haven't written|bạn chưa viết/i.test(body)) return true;
       var hasMenu = document.querySelector('button[jsaction*="review.actionMenu"], button[aria-label*="Actions" i], button[aria-label*="Tùy chọn" i]');
       return !hasMenu;`,
    );
    if (empty) {
      // Contrib trống có thể = đã xóa — vẫn xác nhận thêm qua place nếu có
      console.log("[maps-delete] contrib trống / không có menu — thử place để xác nhận");
    } else {
      const r = await deleteOnContribReviewsPage(page, snippet);
      if (r.ok) {
        return { ok: true, alreadyGone: false, detail: r.detail };
      }
      failures.push(r.detail);
      console.warn(`[maps-delete] contrib fail: ${r.detail} — fallback place`);
    }
  }

  // B) Specific review link — chỉ ok khi trang báo đã xóa
  if (link && isLikelySpecificReviewUrl(link)) {
    throwIfAborted();
    console.log(`[maps-delete] goto specific reviewLink ${link.slice(0, 100)}`);
    await page.goto(link, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await sleep(1000);
    await human.pause(200, 500);

    if (await pageSaysDeleted(page)) {
      return {
        ok: true,
        alreadyGone: true,
        detail: "Review đã không còn trên link",
      };
    }

    let confirmedButUnverified = false;
    for (let i = 0; i < 3; i++) {
      if (await tryDeleteViaActionMenu(page)) {
        await sleep(2200);
        await page
          .goto(link, { waitUntil: "domcontentloaded", timeout: 30_000 })
          .catch(() => undefined);
        await sleep(900);
        if (await pageSaysDeleted(page)) {
          return {
            ok: true,
            alreadyGone: false,
            detail: "Đã xóa qua reviewLink (đã xác nhận trang báo xóa)",
          };
        }
        // Có bấm Confirm nhưng trang chưa báo xóa → KHÔNG ok:true
        confirmedButUnverified = true;
        console.warn(
          "[maps-delete] đã confirm trên reviewLink nhưng trang chưa báo đã xóa — fallback place",
        );
        break;
      }
      await sleep(400);
    }
    if (confirmedButUnverified) {
      failures.push(
        "Đã confirm trên reviewLink nhưng trang chưa xác nhận đã xóa",
      );
    } else {
      failures.push("Không mở/xóa được menu trên reviewLink");
    }
  }

  // C) Place page
  throwIfAborted();
  const place = payload.placeUrl.trim();
  const withHl = place.includes("hl=")
    ? place
    : `${place}${place.includes("?") ? "&" : "?"}hl=vi`;
  console.log(`[maps-delete] goto place ${withHl.slice(0, 100)}`);
  await page.goto(withHl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await sleep(1200);
  await human.pause(300, 600);

  await openReviewsTab(page);
  await sleep(700);

  const stillOwn = await ownReviewStillOnPlace(page, snippet);
  const stillSnippet =
    snippet.length >= 10 ? await bodyHasSnippet(page, snippet) : false;

  if (!stillOwn && !stillSnippet) {
    // Chỉ alreadyGone khi không thấy “your review” VÀ không thấy nội dung bài
    return {
      ok: true,
      alreadyGone: true,
      detail: "Không còn review của bạn trên place",
    };
  }

  if (stillOwn || stillSnippet) {
    const placeResult = await deleteOwnReviewOnPlace(page, snippet);
    if (placeResult.ok) {
      return { ok: true, alreadyGone: false, detail: placeResult.detail };
    }
    failures.push(placeResult.detail);
  }

  return {
    ok: false,
    alreadyGone: false,
    detail:
      failures.filter(Boolean).slice(-2).join(" · ") ||
      "Không xóa được review trên Maps",
  };
}
