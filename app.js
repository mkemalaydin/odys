/**
 * ODYS - İstemci Tarafı Uygulama Mantığı (v2)
 *
 * ÖNEMLİ: Aşağıdaki API_URL değerini, Google Apps Script projenizi
 * "Web Uygulaması" olarak yayınladıktan sonra aldığınız /exec ile biten
 * URL ile değiştirmeniz gerekir (Dağıt > Yeni Dağıtım > Web Uygulaması).
 *
 * v2 YENİLİKLERİ:
 * - Soru düzenleme/silme, esnek soru ekleme arayüzü (kart tabanlı, Excel'den
 *   içe aktarılan sorular da kaydetmeden önce düzenlenebiliyor)
 * - Sınav düzenleme (ad/süre/tarih), modal bileşeni
 * - Kişi bazlı karne: hem tek sınav istatistiklerinde hem ayrı "Öğrenci Profili"
 *   sekmesinde öğrencinin soru soru cevap dökümü
 * - Ölçme-değerlendirme: KR-20 güvenirlik, SEM, madde-toplam korelasyonu,
 *   çeldirici (distractor) analizi, z-puanı/yüzdelik dilim, geçme notu eşiği,
 *   küçük örneklem uyarısı
 */

const API_URL = "https://script.google.com/macros/s/AKfycbztXfVRtKJWDpLpodQbCMkLYDKrQeD4YUDg2s-EJ9VlctdVSza0SxsoDg4O2Bs1a4unzg/exec";

// ---------------------------------------------------------------------------
// Genel durum (state)
// ---------------------------------------------------------------------------

let currentStudent = null;       // { id, name, token }
let adminToken = sessionStorage.getItem("odys_admin_token") || null;
let currentExam = null;
let currentQuestions = [];
let studentAnswers = [];
let examTimerInterval = null;
let examSecondsLeft = 0;
let examStartedAt = null;

let draftQuestions = [];         // admin: henüz kaydedilmemiş yeni sorular
let editingExistingIndex = null; // admin: hangi kayıtlı sorunun düzenlendiği
let currentTargetExamId = null;
let studentsCache = [];          // admin: öğrenci listesi (profil arama için)
let lastStatsResults = null;     // admin: son yüklenen sınav sonuçları (yeniden çizim için)

// ---------------------------------------------------------------------------
// Yardımcılar: API çağrıları, yükleniyor göstergesi, bildirimler, modal
// ---------------------------------------------------------------------------

function showLoader(show) {
  document.getElementById("loader").style.display = show ? "flex" : "none";
}

function showToast(message, type) {
  let container = document.getElementById("toastContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "toastContainer";
    container.className = "toast-container";
    document.body.appendChild(container);
  }
  const toast = document.createElement("div");
  toast.className = "toast toast-" + (type || "info");
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(function () { toast.classList.add("toast-hide"); }, 3500);
  setTimeout(function () { toast.remove(); }, 4000);
}

function openModal(title, bodyHtml) {
  document.getElementById("modalTitle").textContent = title;
  document.getElementById("modalBody").innerHTML = bodyHtml;
  document.getElementById("modalOverlay").classList.add("active");
}

function closeModal() {
  document.getElementById("modalOverlay").classList.remove("active");
}

document.addEventListener("keydown", function (e) {
  if (e.key === "Escape") closeModal();
});

async function apiPost(action, payload) {
  showLoader(true);
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(Object.assign({ action: action }, payload || {}))
    });
    return await res.json();
  } catch (err) {
    showToast("Sunucuya bağlanılamadı. API_URL ayarını kontrol edin.", "error");
    return { success: false, message: "Bağlantı hatası" };
  } finally {
    showLoader(false);
  }
}

async function apiGet(action, params) {
  showLoader(true);
  try {
    const qs = new URLSearchParams(Object.assign({ action: action }, params || {})).toString();
    const res = await fetch(API_URL + "?" + qs);
    return await res.json();
  } catch (err) {
    showToast("Sunucuya bağlanılamadı. API_URL ayarını kontrol edin.", "error");
    return { success: false, message: "Bağlantı hatası" };
  } finally {
    showLoader(false);
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str === undefined || str === null ? "" : String(str);
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Sayfa yönetimi
// ---------------------------------------------------------------------------

function showPage(pageId) {
  if (examTimerInterval && pageId !== "examPage") {
    if (!confirm("Sınav devam ediyor. Çıkarsanız ilerlemeniz kaybolabilir. Emin misiniz?")) return;
    stopExamTimer();
  }
  document.querySelectorAll(".page").forEach(function (p) { p.classList.remove("active"); });
  document.getElementById(pageId).classList.add("active");
}

window.addEventListener("beforeunload", function (e) {
  if (examTimerInterval) { e.preventDefault(); e.returnValue = ""; }
});

// ---------------------------------------------------------------------------
// Öğrenci: giriş / kayıt
// ---------------------------------------------------------------------------

async function studentLogin() {
  const studentId = document.getElementById("stdId").value.trim();
  const password = document.getElementById("stdPass").value;
  if (!studentId || !password) return showToast("Öğrenci numarası ve şifre gerekli.", "error");

  const res = await apiPost("studentLogin", { studentId: studentId, password: password });
  if (res.success) {
    currentStudent = { id: studentId, name: res.studentName, token: res.token };
    showToast("Hoş geldiniz, " + res.studentName, "success");
    await loadExamSelection();
    showPage("examSelectionPage");
  } else {
    showToast(res.message || "Giriş başarısız.", "error");
  }
}

async function registerStudent() {
  const studentId = document.getElementById("regStdId").value.trim();
  const name = document.getElementById("regName").value.trim();
  const password = document.getElementById("regPass").value;
  if (!studentId || !name || password.length < 4) {
    return showToast("Tüm alanları doldurun (şifre en az 4 karakter).", "error");
  }
  const res = await apiPost("registerStudent", { studentId: studentId, name: name, password: password });
  if (res.success) {
    showToast("Kayıt başarılı, giriş yapabilirsiniz.", "success");
    showPage("loginPage");
  } else {
    showToast(res.message || "Kayıt başarısız.", "error");
  }
}

// ---------------------------------------------------------------------------
// Admin: giriş
// ---------------------------------------------------------------------------

async function adminLogin() {
  const user = document.getElementById("admUser").value.trim();
  const pass = document.getElementById("admPass").value;
  if (!user || !pass) return showToast("Kullanıcı adı ve parola gerekli.", "error");

  const res = await apiPost("adminLogin", { user: user, pass: pass });
  if (res.success) {
    adminToken = res.token;
    sessionStorage.setItem("odys_admin_token", adminToken);
    showToast("Eğitmen girişi başarılı.", "success");
    await loadAdminExamSelects();
    showPage("adminPage");
  } else {
    showToast(res.message || "Giriş başarısız.", "error");
  }
}

function adminTab(tab, btnEl) {
  document.querySelectorAll(".admin-content").forEach(function (el) { el.classList.remove("active-tab"); });
  document.querySelectorAll(".tab-btn").forEach(function (el) { el.classList.remove("active"); });
  document.getElementById("tab-" + tab).classList.add("active-tab");
  if (btnEl) btnEl.classList.add("active");
  if (tab === "students" && !studentsCache.length) loadStudentsList();
}

// ---------------------------------------------------------------------------
// Sınav listesi (öğrenci tarafı) + karne geçmişi
// ---------------------------------------------------------------------------

async function loadExamSelection() {
  const res = await apiGet("getExams", {});
  const select = document.getElementById("courseSelect");
  select.innerHTML = '<option value="">Sınav Seçin</option>';
  if (res.success) {
    if (!res.exams.length) {
      showToast("Şu anda çözebileceğiniz aktif bir sınav yok.", "info");
    }
    res.exams.forEach(function (ex) {
      const opt = document.createElement("option");
      opt.value = ex.id;
      opt.textContent = ex.name + (ex.durationMinutes ? " (" + ex.durationMinutes + " dk)" : "");
      opt.dataset.duration = ex.durationMinutes;
      select.appendChild(opt);
    });
  }
}

async function startExam() {
  const select = document.getElementById("courseSelect");
  const examId = select.value;
  if (!examId) return showToast("Lütfen bir sınav seçin.", "error");

  const selectedOption = select.options[select.selectedIndex];
  const durationMinutes = Number(selectedOption.dataset.duration) || 0;

  const res = await apiGet("getQuestions", { examId: examId });
  if (!res.success || !res.questions.length) return showToast("Bu sınav için soru bulunamadı.", "error");

  currentExam = { id: examId, name: selectedOption.textContent, durationMinutes: durationMinutes };
  currentQuestions = res.questions;
  studentAnswers = new Array(currentQuestions.length).fill(null);
  examStartedAt = Date.now();

  document.getElementById("currentExamTitle").textContent = currentExam.name;
  renderExamQuestions();
  startExamTimer(durationMinutes);
  showPage("examPage");
}

function renderExamQuestions() {
  const container = document.getElementById("examArea");
  container.innerHTML = "";
  const letters = ["A", "B", "C", "D", "E"];

  currentQuestions.forEach(function (q, qIndex) {
    const block = document.createElement("div");
    block.className = "question-block";

    const title = document.createElement("h4");
    title.textContent = (qIndex + 1) + ". " + q.text;
    block.appendChild(title);

    q.opts.forEach(function (optText, optIndex) {
      if (optText === "" || optText === undefined) return;
      const label = document.createElement("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "q" + qIndex;
      radio.value = optIndex;
      radio.onchange = function () { studentAnswers[qIndex] = optIndex; };

      const span = document.createElement("span");
      span.className = "option-text";
      span.textContent = letters[optIndex] + ") " + optText;

      label.appendChild(radio);
      label.appendChild(span);
      block.appendChild(label);
    });

    container.appendChild(block);
  });
}

function startExamTimer(durationMinutes) {
  stopExamTimer();
  const timerEl = document.getElementById("timer");
  if (!durationMinutes || durationMinutes <= 0) {
    timerEl.textContent = "Süre: Sınırsız";
    return;
  }
  examSecondsLeft = durationMinutes * 60;
  updateTimerDisplay();
  examTimerInterval = setInterval(function () {
    examSecondsLeft--;
    updateTimerDisplay();
    if (examSecondsLeft <= 60) document.getElementById("timer").classList.add("timer-warning");
    if (examSecondsLeft <= 0) {
      stopExamTimer();
      showToast("Süre doldu, sınavınız gönderiliyor.", "error");
      submitExamResults(true);
    }
  }, 1000);
}

function updateTimerDisplay() {
  const m = Math.floor(examSecondsLeft / 60).toString().padStart(2, "0");
  const s = (examSecondsLeft % 60).toString().padStart(2, "0");
  document.getElementById("timer").textContent = "Süre: " + m + ":" + s;
}

function stopExamTimer() {
  if (examTimerInterval) { clearInterval(examTimerInterval); examTimerInterval = null; }
  document.getElementById("timer").classList.remove("timer-warning");
}

async function submitExamResults(auto) {
  if (!auto) {
    const unanswered = studentAnswers.filter(function (a) { return a === null; }).length;
    if (unanswered > 0 && !confirm(unanswered + " soruyu boş bıraktınız. Yine de sınavı bitirmek istiyor musunuz?")) return;
  }

  stopExamTimer();
  const durationSeconds = Math.round((Date.now() - examStartedAt) / 1000);

  const res = await apiPost("submitExam", {
    studentId: currentStudent.id,
    examId: currentExam.id,
    answers: studentAnswers,
    duration: durationSeconds,
    token: currentStudent.token
  });

  if (res.success) {
    document.getElementById("scoreDisplay").textContent = res.score + " / 100";
    document.getElementById("resultDetails").innerHTML =
      "<p>Doğru: " + res.correct + " &nbsp;|&nbsp; Yanlış: " + res.wrong + " &nbsp;|&nbsp; Boş: " + res.blank + " / " + res.total + "</p>";
    showPage("resultPage");
  } else if (res.alreadySubmitted) {
    showToast(res.message, "error");
    showPage("examSelectionPage");
  } else {
    showToast(res.message || "Gönderim başarısız, tekrar deneyin.", "error");
  }
}

async function loadHistory() {
  const res = await apiGet("getStudentHistory", { studentId: currentStudent.id, token: currentStudent.token });
  const container = document.getElementById("historyList");
  container.innerHTML = "";
  if (res.success && res.history.length) {
    res.history.slice().reverse().forEach(function (h) {
      const row = document.createElement("div");
      row.className = "history-row";
      row.innerHTML =
        "<div><strong>" + escapeHtml(h.examName) + "</strong><br><small>" + new Date(h.date).toLocaleString("tr-TR") + "</small></div>" +
        "<div class='history-score'>" + h.score + "</div>";
      container.appendChild(row);
    });
  } else {
    container.innerHTML = "<div class='empty-state'>📭 Henüz tamamlanmış bir sınavınız yok.</div>";
  }
  showPage("historyPage");
}

// ---------------------------------------------------------------------------
// Admin: sınav oluşturma / düzenleme / listeleme / aktif-pasif / silme
// ---------------------------------------------------------------------------

async function loadAdminExamSelects() {
  const res = await apiGet("getExams", { scope: "admin", token: adminToken });
  if (!res.success) return showToast(res.message || "Sınavlar alınamadı.", "error");

  const targetSelect = document.getElementById("targetExamSelect");
  const statsSelect = document.getElementById("statsExamSelect");
  const prevTarget = targetSelect.value;
  targetSelect.innerHTML = "";
  statsSelect.innerHTML = '<option value="">Sınav Seçin</option>';

  res.exams.forEach(function (ex) {
    const opt1 = document.createElement("option");
    opt1.value = ex.id; opt1.textContent = ex.name;
    targetSelect.appendChild(opt1);

    const opt2 = document.createElement("option");
    opt2.value = ex.id; opt2.textContent = ex.name;
    statsSelect.appendChild(opt2);
  });

  if (prevTarget && res.exams.some(function (ex) { return ex.id === prevTarget; })) {
    targetSelect.value = prevTarget;
  }
  renderExamManagementList(res.exams);
  if (targetSelect.value) onTargetExamChange();
}

function renderExamManagementList(exams) {
  let container = document.getElementById("examListContainer");
  container.innerHTML = exams.length ? "" : "<div class='empty-state'>📋 Henüz sınav oluşturulmadı.</div>";

  exams.forEach(function (ex) {
    const row = document.createElement("div");
    row.className = "exam-row";
    row.innerHTML =
      "<div class='exam-row-info'>" +
      "<span class='exam-row-name'>" + escapeHtml(ex.name) + "</span>" +
      "<span class='exam-row-meta'>" + (ex.durationMinutes ? ex.durationMinutes + " dk" : "Süresiz") +
      (ex.startDate ? " • Başlangıç: " + new Date(ex.startDate).toLocaleString("tr-TR") : "") +
      (ex.endDate ? " • Bitiş: " + new Date(ex.endDate).toLocaleString("tr-TR") : "") + "</span>" +
      "</div>" +
      "<span class='q-badge " + (ex.isActive ? "badge-green" : "badge-red") + "'>" + (ex.isActive ? "Aktif" : "Pasif") + "</span>" +
      "<div class='exam-row-actions'></div>";

    const actions = row.querySelector(".exam-row-actions");

    const editBtn = document.createElement("button");
    editBtn.type = "button"; editBtn.className = "icon-btn"; editBtn.title = "Düzenle"; editBtn.textContent = "✏️";
    editBtn.onclick = function () { openEditExamModal(ex); };

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button"; toggleBtn.className = "icon-btn"; toggleBtn.title = ex.isActive ? "Pasifleştir" : "Aktifleştir";
    toggleBtn.textContent = ex.isActive ? "⏸️" : "▶️";
    toggleBtn.onclick = function () { toggleExamActive(ex.id); };

    const delBtn = document.createElement("button");
    delBtn.type = "button"; delBtn.className = "icon-btn icon-btn-danger"; delBtn.title = "Sil"; delBtn.textContent = "🗑️";
    delBtn.onclick = function () { deleteExam(ex.id, ex.name); };

    actions.appendChild(editBtn);
    actions.appendChild(toggleBtn);
    actions.appendChild(delBtn);
    container.appendChild(row);
  });
}

async function createExam() {
  const name = document.getElementById("newExamName").value.trim();
  const durationMinutes = Number(document.getElementById("newExamDuration").value) || 0;
  const startDate = document.getElementById("newExamStart").value;
  const endDate = document.getElementById("newExamEnd").value;
  if (!name) return showToast("Sınav adı girin.", "error");

  const res = await apiPost("createExam", { name: name, durationMinutes: durationMinutes, startDate: startDate, endDate: endDate, token: adminToken });
  if (res.success) {
    showToast("Sınav oluşturuldu.", "success");
    document.getElementById("newExamName").value = "";
    document.getElementById("newExamDuration").value = "";
    document.getElementById("newExamStart").value = "";
    document.getElementById("newExamEnd").value = "";
    await loadAdminExamSelects();
  } else {
    showToast(res.message || "Sınav oluşturulamadı.", "error");
  }
}

function openEditExamModal(ex) {
  const html =
    "<input type='text' id='editExamName' value=\"" + escapeHtml(ex.name) + "\" placeholder='Sınav Adı'>" +
    "<input type='number' id='editExamDuration' value='" + (ex.durationMinutes || "") + "' placeholder='Süre (dakika)' min='0'>" +
    "<label class='field-label'>Başlangıç</label><input type='datetime-local' id='editExamStart' value=\"" + (ex.startDate || "") + "\">" +
    "<label class='field-label'>Bitiş</label><input type='datetime-local' id='editExamEnd' value=\"" + (ex.endDate || "") + "\">" +
    "<button type='button' class='btn-primary' style='margin-top:15px;' onclick=\"saveExamEdit('" + ex.id + "')\">Kaydet</button>";
  openModal("Sınavı Düzenle", html);
}

async function saveExamEdit(examId) {
  const res = await apiPost("updateExam", {
    examId: examId,
    name: document.getElementById("editExamName").value.trim(),
    durationMinutes: Number(document.getElementById("editExamDuration").value) || 0,
    startDate: document.getElementById("editExamStart").value,
    endDate: document.getElementById("editExamEnd").value,
    token: adminToken
  });
  if (res.success) {
    showToast("Sınav güncellendi.", "success");
    closeModal();
    await loadAdminExamSelects();
  } else {
    showToast(res.message || "Güncellenemedi.", "error");
  }
}

async function toggleExamActive(examId) {
  const res = await apiPost("toggleExamActive", { examId: examId, token: adminToken });
  if (res.success) await loadAdminExamSelects();
  else showToast(res.message || "İşlem başarısız.", "error");
}

async function deleteExam(examId, examName) {
  if (!confirm('"' + examName + '" sınavını silmek istediğinize emin misiniz? Sorular silinecek, öğrenci sonuç geçmişi korunacaktır.')) return;
  const res = await apiPost("deleteExam", { examId: examId, token: adminToken });
  if (res.success) { showToast("Sınav silindi.", "success"); await loadAdminExamSelects(); }
  else showToast(res.message || "İşlem başarısız.", "error");
}

// ---------------------------------------------------------------------------
// Admin: soru yönetimi — kayıtlı sorular (görüntüle / düzenle / sil)
// ---------------------------------------------------------------------------

async function onTargetExamChange() {
  currentTargetExamId = document.getElementById("targetExamSelect").value;
  draftQuestions = [];
  editingExistingIndex = null;
  renderComposer();
  await loadExistingQuestions();
}

async function loadExistingQuestions() {
  const container = document.getElementById("existingQuestionsContainer");
  if (!currentTargetExamId) { container.innerHTML = ""; return; }

  const res = await apiGet("getQuestions", { examId: currentTargetExamId, scope: "admin", token: adminToken });
  if (!res.success) return showToast(res.message || "Sorular alınamadı.", "error");

  container.innerHTML = "";
  if (!res.questions.length) {
    container.innerHTML = "<div class='empty-state'>✍️ Bu sınavda henüz soru yok. Aşağıdan ekleyin.</div>";
    return;
  }

  const letters = ["A", "B", "C", "D", "E"];
  res.questions.forEach(function (q, idx) {
    const item = document.createElement("div");
    item.className = "existing-q-row";
    item.id = "existingQ" + idx;
    item.innerHTML =
      "<div class='existing-q-view'>" +
      "<span class='existing-q-num'>" + (idx + 1) + "</span>" +
      "<span class='existing-q-text'>" + escapeHtml(q.text) + "</span>" +
      "<span class='q-badge badge-green'>Doğru: " + letters[q.correct] + "</span>" +
      "<span class='existing-q-actions'>" +
      "<button type='button' class='icon-btn' title='Düzenle' onclick='editExistingQuestion(" + idx + ")'>✏️</button>" +
      "<button type='button' class='icon-btn icon-btn-danger' title='Sil' onclick='deleteExistingQuestion(" + idx + ", \"" + escapeHtml(q.text).replace(/"/g, "&quot;").substring(0, 30) + "...\")'>🗑️</button>" +
      "</span></div>";
    item.dataset.question = JSON.stringify(q);
    container.appendChild(item);
  });
}

function editExistingQuestion(idx) {
  const item = document.getElementById("existingQ" + idx);
  const q = JSON.parse(item.dataset.question);
  editingExistingIndex = idx;
  item.innerHTML = buildQuestionCardHtml(q, "existingEdit" + idx);
  item.querySelector(".card-save-btn").onclick = function () { saveExistingQuestionEdit(idx); };
  item.querySelector(".card-cancel-btn").onclick = function () { loadExistingQuestions(); };
}

async function saveExistingQuestionEdit(idx) {
  const q = readQuestionCard("existingEdit" + idx);
  if (!q) return showToast("Soru metni ve doğru cevap seçimi zorunludur.", "error");
  const res = await apiPost("updateQuestion", { examId: currentTargetExamId, questionIndex: idx, text: q.text, opts: q.opts, correct: q.correct, token: adminToken });
  if (res.success) { showToast("Soru güncellendi.", "success"); await loadExistingQuestions(); }
  else showToast(res.message || "Güncellenemedi.", "error");
}

async function deleteExistingQuestion(idx, preview) {
  if (!confirm('"' + preview + '" sorusunu silmek istediğinize emin misiniz?')) return;
  const res = await apiPost("deleteQuestion", { examId: currentTargetExamId, questionIndex: idx, token: adminToken });
  if (res.success) { showToast("Soru silindi.", "success"); await loadExistingQuestions(); }
  else showToast(res.message || "Silinemedi.", "error");
}

// ---------------------------------------------------------------------------
// Admin: yeni soru ekleme (kart tabanlı, manuel + Excel birleşik)
// ---------------------------------------------------------------------------

function buildQuestionCardHtml(q, uid) {
  const letters = ["A", "B", "C", "D", "E"];
  q = q || { text: "", opts: ["", "", "", "", ""], correct: "" };
  return (
    "<div class='question-input-group' id='" + uid + "'>" +
    "<textarea class='card-text' placeholder='Soru metni'>" + escapeHtml(q.text) + "</textarea>" +
    "<div class='opt-grid'>" +
    letters.map(function (l, idx) {
      return "<input type='text' class='card-opt' data-idx='" + idx + "' value=\"" + escapeHtml(q.opts[idx] || "") + "\" placeholder='Şık " + l + (idx === 4 ? " (opsiyonel)" : "") + "'>";
    }).join("") +
    "</div>" +
    "<select class='card-correct' style='margin-top:10px;'>" +
    "<option value=''>Doğru Şıkkı Seçin</option>" +
    letters.map(function (l, idx) { return "<option value='" + idx + "'" + (Number(q.correct) === idx ? " selected" : "") + ">" + l + "</option>"; }).join("") +
    "</select>" +
    "<div style='display:flex; gap:10px; margin-top:12px;'>" +
    "<button type='button' class='btn-primary card-save-btn' style='width:auto;padding:8px 18px;'>Kaydet</button>" +
    "<button type='button' class='btn-back card-cancel-btn' style='width:auto;padding:8px 18px;margin-top:0;'>Vazgeç</button>" +
    "</div></div>"
  );
}

function readQuestionCard(uid) {
  const card = document.getElementById(uid);
  const text = card.querySelector(".card-text").value.trim();
  const opts = [];
  card.querySelectorAll(".card-opt").forEach(function (input) { opts[Number(input.dataset.idx)] = input.value.trim(); });
  const correct = card.querySelector(".card-correct").value;
  if (!text || correct === "") return null;
  return { text: text, opts: opts, correct: Number(correct) };
}

function addBlankQuestionCard() {
  draftQuestions.push({ text: "", opts: ["", "", "", "", ""], correct: "" });
  renderComposer();
}

function renderComposer() {
  const container = document.getElementById("questionComposer");
  container.innerHTML = "";
  draftQuestions.forEach(function (q, i) {
    const wrap = document.createElement("div");
    wrap.className = "draft-card-wrap";
    wrap.innerHTML =
      "<div class='question-input-group'>" +
      "<div style='display:flex;justify-content:space-between;align-items:center;'>" +
      "<h4>Yeni Soru " + (i + 1) + "</h4>" +
      "<button type='button' class='icon-btn icon-btn-danger' title='Kaldır'>✕</button>" +
      "</div>" +
      "<textarea class='draft-text' placeholder='Soru metni'>" + escapeHtml(q.text) + "</textarea>" +
      "<div class='opt-grid'>" +
      ["A", "B", "C", "D", "E"].map(function (l, idx) {
        return "<input type='text' class='draft-opt' data-idx='" + idx + "' value=\"" + escapeHtml(q.opts[idx] || "") + "\" placeholder='Şık " + l + (idx === 4 ? " (opsiyonel)" : "") + "'>";
      }).join("") +
      "</div>" +
      "<select class='draft-correct' style='margin-top:10px;'>" +
      "<option value=''>Doğru Şıkkı Seçin</option>" +
      ["A", "B", "C", "D", "E"].map(function (l, idx) { return "<option value='" + idx + "'" + (Number(q.correct) === idx ? " selected" : "") + ">" + l + "</option>"; }).join("") +
      "</select></div>";

    wrap.querySelector(".draft-text").oninput = function (e) { draftQuestions[i].text = e.target.value; };
    wrap.querySelectorAll(".draft-opt").forEach(function (input) {
      input.oninput = function (e) { draftQuestions[i].opts[Number(e.target.dataset.idx)] = e.target.value; };
    });
    wrap.querySelector(".draft-correct").onchange = function (e) { draftQuestions[i].correct = e.target.value; };
    wrap.querySelector(".icon-btn-danger").onclick = function () { draftQuestions.splice(i, 1); renderComposer(); };

    container.appendChild(wrap);
  });
  document.getElementById("saveAllBtn").style.display = draftQuestions.length ? "block" : "none";
}

function handleExcelUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (e) {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      const letterToIndex = { A: 0, B: 1, C: 2, D: 3, E: 4, "1": 0, "2": 1, "3": 2, "4": 3, "5": 4 };

      let importedCount = 0;
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || !row[0]) continue;
        const correctRaw = String(row[6] || "").trim().toUpperCase();
        draftQuestions.push({
          text: String(row[0]),
          opts: [row[1], row[2], row[3], row[4], row[5]].map(function (v) { return v === undefined ? "" : String(v); }),
          correct: letterToIndex[correctRaw] !== undefined ? letterToIndex[correctRaw] : ""
        });
        importedCount++;
      }

      if (!importedCount) {
        showToast("Excel dosyasında geçerli soru bulunamadı. Sütun sırasını kontrol edin: Soru | A | B | C | D | E | Doğru Cevap", "error");
      } else {
        showToast(importedCount + " soru içe aktarıldı. Kaydetmeden önce gözden geçirip düzenleyebilirsiniz.", "success");
        renderComposer();
      }
    } catch (err) {
      showToast("Excel dosyası okunamadı: " + err.message, "error");
    }
  };
  reader.readAsArrayBuffer(file);
  event.target.value = "";
}

async function saveBulkQuestions() {
  if (!currentTargetExamId) return showToast("Lütfen hedef sınavı seçin.", "error");
  const valid = draftQuestions.filter(function (q) { return q.text.trim() && q.correct !== ""; });
  if (!valid.length) return showToast("Kaydedilecek geçerli soru bulunamadı. Soru metni ve doğru cevap zorunludur.", "error");
  if (valid.length !== draftQuestions.length) {
    showToast((draftQuestions.length - valid.length) + " eksik soru (metin veya doğru cevap yok) atlanacak.", "info");
  }

  const res = await apiPost("addBulkQuestions", { examId: currentTargetExamId, questions: valid, token: adminToken });
  if (res.success) {
    showToast(res.count + " soru kaydedildi.", "success");
    draftQuestions = [];
    renderComposer();
    await loadExistingQuestions();
  } else {
    showToast(res.message || "Sorular kaydedilemedi.", "error");
  }
}

// ---------------------------------------------------------------------------
// Ölçme-değerlendirme yardımcı istatistik fonksiyonları
// ---------------------------------------------------------------------------

function mean(arr) { return arr.reduce(function (a, b) { return a + b; }, 0) / arr.length; }
function variance(arr) { const m = mean(arr); return mean(arr.map(function (x) { return (x - m) * (x - m); })); }
function stddev(arr) { return Math.sqrt(variance(arr)); }
function median(arr) {
  const s = arr.slice().sort(function (a, b) { return a - b; });
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function pearson(x, y) {
  const mx = mean(x), my = mean(y);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < x.length; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : num / denom;
}

// Her öğrencinin kendi soru/cevap anlık görüntüsünü kullanarak k x n doğruluk matrisi kurar.
// (Sınav esnasında bir soru düzenlenmişse bile her öğrenci kendi gördüğü soruya göre değerlendirilir.)
function buildItemMatrix(results) {
  const k = Math.max.apply(null, results.map(function (r) { return r.questions.length; }));
  const correctMatrix = results.map(function (r) {
    const row = [];
    for (let qi = 0; qi < k; qi++) {
      const q = r.questions[qi];
      const ans = r.answers[qi];
      const isCorrect = q && ans !== null && ans !== undefined && ans !== "" && String(ans) === String(q.correct);
      row.push(isCorrect ? 1 : 0);
    }
    return row;
  });
  const refQuestions = [];
  for (let qi = 0; qi < k; qi++) {
    let ref = null;
    for (let ri = 0; ri < results.length; ri++) { if (results[ri].questions[qi]) { ref = results[ri].questions[qi]; break; } }
    refQuestions.push(ref);
  }
  const totalScores = correctMatrix.map(function (row) { return row.reduce(function (a, b) { return a + b; }, 0); });
  return { k: k, correctMatrix: correctMatrix, refQuestions: refQuestions, totalScores: totalScores };
}

function computeKR20(matrix) {
  const varX = variance(matrix.totalScores);
  if (varX === 0) return null;
  let sumPQ = 0;
  for (let qi = 0; qi < matrix.k; qi++) {
    const col = matrix.correctMatrix.map(function (row) { return row[qi]; });
    const p = mean(col);
    sumPQ += p * (1 - p);
  }
  const kr20 = (matrix.k / (matrix.k - 1)) * (1 - sumPQ / varX);
  return kr20;
}

// ---------------------------------------------------------------------------
// Admin: detaylı analiz (madde analizi + kişi bazlı karne)
// ---------------------------------------------------------------------------

let statsChart = null;
let difficultyChart = null;

async function loadStatsForExam() {
  const examId = document.getElementById("statsExamSelect").value;
  const container = document.getElementById("statsContent");
  const downloadBtn = document.getElementById("downloadExcelBtn");
  container.innerHTML = "";
  downloadBtn.style.display = "none";
  lastStatsResults = null;
  if (!examId) return;

  const res = await apiGet("getResults", { examId: examId, token: adminToken });
  if (!res.success) return showToast(res.message || "Sonuçlar alınamadı.", "error");
  if (!res.results.length) {
    container.innerHTML = "<div class='empty-state'>📭 Bu sınav için henüz sonuç yok.</div>";
    return;
  }

  lastStatsResults = res.results;
  downloadBtn.style.display = "inline-block";
  renderFullStats();
}

function renderFullStats() {
  const results = lastStatsResults;
  if (!results) return;
  const container = document.getElementById("statsContent");
  container.innerHTML = "";

  const threshold = Number(document.getElementById("passThreshold").value) || 50;

  if (results.length < 30) {
    const level = results.length < 10 ? "warning-strong" : "warning-mild";
    const banner = document.createElement("div");
    banner.className = "sample-warning " + level;
    banner.innerHTML = "⚠️ Örneklem küçük (n=" + results.length + "). Zorluk/ayırt edicilik indeksleri ve güvenirlik katsayısı bu örneklemde temkinli yorumlanmalıdır" + (results.length < 10 ? " (n≥30 önerilir)." : ".");
    container.appendChild(banner);
  }

  const matrix = buildItemMatrix(results);
  const kr20 = matrix.k > 1 ? computeKR20(matrix) : null;
  const sd = stddev(matrix.totalScores);
  const sem = kr20 !== null && kr20 <= 1 ? sd * Math.sqrt(Math.max(0, 1 - kr20)) : null;

  renderSummaryCards(results, matrix, kr20, sem, threshold);
  renderScoreChart(results);
  renderDifficultyChart(matrix);
  renderStudentTable(results, matrix, threshold);
  renderItemAnalysis(results, matrix);
}

function renderSummaryCards(results, matrix, kr20, sem, threshold) {
  const scores = results.map(function (r) { return r.score; });
  const passCount = scores.filter(function (s) { return s >= threshold; }).length;

  const cards = [
    { label: "Katılımcı", value: results.length },
    { label: "Ortalama", value: mean(scores).toFixed(1) },
    { label: "Medyan", value: median(scores).toFixed(1) },
    { label: "Std. Sapma", value: stddev(scores).toFixed(1) },
    { label: "En Yüksek / En Düşük", value: Math.max.apply(null, scores) + " / " + Math.min.apply(null, scores) },
    { label: "KR-20 Güvenirlik", value: kr20 === null ? "—" : kr20.toFixed(2) },
    { label: "Ölçme Std. Hatası (SEM)", value: sem === null ? "—" : sem.toFixed(2) },
    { label: "Geçme Oranı (≥" + threshold + ")", value: passCount + " / " + results.length + " (%" + Math.round((passCount / results.length) * 100) + ")" }
  ];

  const grid = document.createElement("div");
  grid.className = "summary-grid";
  cards.forEach(function (s) {
    const card = document.createElement("div");
    card.className = "stat-card";
    card.innerHTML = "<h4>" + s.label + "</h4><div class='stat-value'>" + s.value + "</div>";
    grid.appendChild(card);
  });
  document.getElementById("statsContent").appendChild(grid);
}

function renderScoreChart(results) {
  const wrap = document.createElement("div");
  wrap.className = "card";
  wrap.innerHTML = "<h4>Puan Dağılımı</h4><canvas id='scoreChart' height='90'></canvas>";
  document.getElementById("statsContent").appendChild(wrap);

  const buckets = { "0-49": 0, "50-59": 0, "60-69": 0, "70-79": 0, "80-89": 0, "90-100": 0 };
  results.forEach(function (r) {
    const s = r.score;
    if (s < 50) buckets["0-49"]++; else if (s < 60) buckets["50-59"]++; else if (s < 70) buckets["60-69"]++;
    else if (s < 80) buckets["70-79"]++; else if (s < 90) buckets["80-89"]++; else buckets["90-100"]++;
  });

  if (statsChart) statsChart.destroy();
  statsChart = new Chart(document.getElementById("scoreChart").getContext("2d"), {
    type: "bar",
    data: { labels: Object.keys(buckets), datasets: [{ label: "Öğrenci Sayısı", data: Object.values(buckets), backgroundColor: "#800000", borderRadius: 6 }] },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
  });
}

function renderDifficultyChart(matrix) {
  const wrap = document.createElement("div");
  wrap.className = "card";
  wrap.innerHTML = "<h4>Madde Zorluk Dağılımı <small style='font-weight:normal;color:#888;'>(her çubuk bir soru; yüksek = kolay)</small></h4><canvas id='difficultyChart' height='90'></canvas>";
  document.getElementById("statsContent").appendChild(wrap);

  const pValues = [];
  for (let qi = 0; qi < matrix.k; qi++) pValues.push(mean(matrix.correctMatrix.map(function (row) { return row[qi]; })));

  if (difficultyChart) difficultyChart.destroy();
  difficultyChart = new Chart(document.getElementById("difficultyChart").getContext("2d"), {
    type: "bar",
    data: {
      labels: pValues.map(function (_, i) { return "S" + (i + 1); }),
      datasets: [{
        label: "Zorluk İndeksi (p)", data: pValues,
        backgroundColor: pValues.map(function (p) { return p >= 0.7 ? "#28a745" : p >= 0.4 ? "#ffc107" : "#dc3545"; }),
        borderRadius: 4
      }]
    },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { min: 0, max: 1 } } }
  });
}

function renderStudentTable(results, matrix, threshold) {
  const scores = results.map(function (r) { return r.score; });
  const m = mean(scores), sd = stddev(scores) || 1;
  const sorted = scores.slice().sort(function (a, b) { return a - b; });

  const wrap = document.createElement("div");
  wrap.className = "card";
  wrap.innerHTML = "<h4>Öğrenci Bazlı Sonuçlar</h4><div class='table-scroll'><table class='data-table'>" +
    "<thead><tr><th>Öğrenci</th><th>Puan</th><th>D/Y/B</th><th>z-Puanı</th><th>Yüzdelik Dilim</th><th></th></tr></thead><tbody></tbody></table></div>";
  document.getElementById("statsContent").appendChild(wrap);
  const tbody = wrap.querySelector("tbody");

  results.slice().sort(function (a, b) { return b.score - a.score; }).forEach(function (r) {
    const z = ((r.score - m) / sd).toFixed(2);
    const below = sorted.filter(function (s) { return s < r.score; }).length;
    const percentile = Math.round((below / sorted.length) * 100);
    const tr = document.createElement("tr");
    if (r.score < threshold) tr.classList.add("row-below-threshold");
    tr.innerHTML =
      "<td>" + escapeHtml(r.studentName || r.studentId) + "</td>" +
      "<td><strong>" + r.score + "</strong></td>" +
      "<td>" + r.correct + " / " + r.wrong + " / " + r.blank + "</td>" +
      "<td>" + z + "</td>" +
      "<td>%" + percentile + "</td>" +
      "<td><button type='button' class='btn-secondary' style='width:auto;padding:6px 14px;font-size:13px;'>Karne Gör</button></td>";
    tr.querySelector("button").onclick = function () {
      openModal("Sınav Karnesi — " + (r.studentName || r.studentId), renderAnswerSheetHtml(r));
    };
    tbody.appendChild(tr);
  });
}

// Tek bir öğrencinin bir sınavdaki soru soru cevap dökümü (karne)
function renderAnswerSheetHtml(r) {
  const letters = ["A", "B", "C", "D", "E"];
  const header =
    "<div class='karne-header'>" +
    "<div><span class='index-title'>Puan</span><div class='index-val' style='font-size:24px;'>" + r.score + "</div></div>" +
    "<div><span class='index-title'>Doğru/Yanlış/Boş</span><div class='index-val'>" + r.correct + " / " + r.wrong + " / " + r.blank + "</div></div>" +
    "<div><span class='index-title'>Tarih</span><div class='index-val' style='font-size:14px;'>" + new Date(r.date).toLocaleString("tr-TR") + "</div></div>" +
    "</div>";

  const items = r.questions.map(function (q, qi) {
    const ans = r.answers[qi];
    const isBlank = ans === null || ans === undefined || ans === "";
    const isCorrect = !isBlank && String(ans) === String(q.correct);
    const statusClass = isBlank ? "karne-blank" : isCorrect ? "karne-correct" : "karne-wrong";
    const statusIcon = isBlank ? "◻ Boş" : isCorrect ? "✔ Doğru" : "✘ Yanlış";
    return "<div class='karne-item " + statusClass + "'>" +
      "<div class='karne-item-head'><span>" + (qi + 1) + ". " + escapeHtml(q.text) + "</span><span class='karne-status'>" + statusIcon + "</span></div>" +
      "<div class='karne-item-detail'>Verilen cevap: <strong>" + (isBlank ? "—" : letters[ans] + ") " + escapeHtml(q.opts[ans] || "")) + "</strong>" +
      (!isCorrect ? " &nbsp;|&nbsp; Doğru cevap: <strong>" + letters[q.correct] + ") " + escapeHtml(q.opts[q.correct] || "") + "</strong>" : "") +
      "</div></div>";
  }).join("");

  return header + "<div class='karne-list'>" + items + "</div>";
}

function difficultyLabel(p) { return p >= 0.7 ? "Kolay" : p >= 0.4 ? "Orta" : "Zor"; }
function discriminationLabel(d) { return d >= 0.4 ? "Çok iyi ayırt edici" : d >= 0.3 ? "İyi" : d >= 0.2 ? "Kabul edilebilir" : "Zayıf — gözden geçirin"; }

function renderItemAnalysis(results, matrix) {
  const wrap = document.createElement("div");
  wrap.innerHTML = "<h3 style='margin:25px 0 5px;color:var(--indigo);'>Madde Analizi</h3>";
  document.getElementById("statsContent").appendChild(wrap);

  const sortedIdx = matrix.totalScores.map(function (score, i) { return { score: score, i: i }; }).sort(function (a, b) { return b.score - a.score; });
  const groupSize = Math.max(1, Math.round(sortedIdx.length * 0.27));
  const upperIdx = sortedIdx.slice(0, groupSize).map(function (o) { return o.i; });
  const lowerIdx = sortedIdx.slice(-groupSize).map(function (o) { return o.i; });
  const letters = ["A", "B", "C", "D", "E"];

  for (let qi = 0; qi < matrix.k; qi++) {
    const q = matrix.refQuestions[qi];
    if (!q) continue;
    const col = matrix.correctMatrix.map(function (row) { return row[qi]; });
    const p = mean(col);
    const upperP = mean(upperIdx.map(function (i) { return col[i]; }));
    const lowerP = mean(lowerIdx.map(function (i) { return col[i]; }));
    const d = upperP - lowerP;
    const itemTotalCorr = pearson(col, matrix.totalScores);

    const optionCounts = [0, 0, 0, 0, 0];
    let blankCount = 0;
    results.forEach(function (r) {
      const ans = r.answers[qi];
      if (ans === null || ans === undefined || ans === "") { blankCount++; return; }
      optionCounts[Number(ans)]++;
    });

    const flags = [];
    if (d < 0.2) flags.push("Zayıf ayırt edicilik");
    if (p >= 0.95) flags.push("Çok kolay");
    if (p <= 0.05) flags.push("Çok zor");
    q.opts.forEach(function (optText, idx) {
      if (optText === "" || idx === Number(q.correct)) return;
      if (optionCounts[idx] === 0) flags.push(letters[idx] + " şıkkı hiç seçilmemiş (işlevsiz çeldirici)");
      const upperChose = upperIdx.filter(function (i) { return Number(results[i].answers[qi]) === idx; }).length / upperIdx.length;
      const lowerChose = lowerIdx.filter(function (i) { return Number(results[i].answers[qi]) === idx; }).length / lowerIdx.length;
      if (upperChose > lowerChose && upperChose > 0.15) flags.push(letters[idx] + " şıkkı başarılı öğrenciler tarafından daha çok seçilmiş — anahtar kontrolü önerilir");
    });

    const card = document.createElement("div");
    card.className = "detailed-q-card" + (flags.length ? " flagged" : "");
    card.innerHTML =
      "<div class='q-header'><h5>Soru " + (qi + 1) + "</h5><span class='q-badge " + (p >= 0.4 && p <= 0.9 ? "badge-green" : "badge-amber") + "'>" + Math.round(p * 100) + "% doğru</span></div>" +
      "<div class='q-text-preview'>" + escapeHtml(q.text) + "</div>" +
      (flags.length ? "<div class='flag-banner'>🚩 " + flags.join(" · ") + "</div>" : "") +
      "<div class='q-stats-grid'>" +
      "<div class='options-bars'><h6>Şık Dağılımı</h6>" +
      q.opts.map(function (optText, idx) {
        if (optText === "") return "";
        const count = optionCounts[idx];
        const pct = Math.round((count / results.length) * 100);
        const isCorrect = idx === Number(q.correct);
        return "<div class='opt-bar-row'><span class='opt-label" + (isCorrect ? " correct-label" : "") + "'>" + letters[idx] + "</span>" +
          "<div class='opt-bar-container'><div class='opt-bar-fill' style='width:" + pct + "%;background:" + (isCorrect ? "#28a745" : "#800000") + ";'></div></div>" +
          "<span class='opt-count'>" + count + " (" + pct + "%)</span></div>";
      }).join("") +
      "<div class='opt-bar-row'><span class='opt-label'>Boş</span>" +
      "<div class='opt-bar-container'><div class='opt-bar-fill' style='width:" + Math.round((blankCount / results.length) * 100) + "%;background:#ccc;'></div></div>" +
      "<span class='opt-count'>" + blankCount + "</span></div>" +
      "</div>" +
      "<div class='index-box'>" +
      "<div class='index-item'><span class='index-title'>Zorluk İndeksi (p)</span><span class='index-val'>" + p.toFixed(2) + " <small>" + difficultyLabel(p) + "</small></span></div>" +
      "<div class='index-item'><span class='index-title'>Ayırt Edicilik (D)</span><span class='index-val'>" + d.toFixed(2) + " <small>" + discriminationLabel(d) + "</small></span></div>" +
      "<div class='index-item'><span class='index-title'>Madde-Toplam Korelasyonu</span><span class='index-val'>" + itemTotalCorr.toFixed(2) + "</span></div>" +
      "</div></div></div>";
    document.getElementById("statsContent").appendChild(card);
  }
}

function downloadResultsExcel() {
  const results = lastStatsResults;
  if (!results || !results.length) return;

  const resultRows = results.map(function (r) {
    return {
      "Öğrenci No": r.studentId, "Ad Soyad": r.studentName, "Puan": r.score, "Doğru": r.correct,
      "Yanlış": r.wrong, "Boş": r.blank, "Toplam": r.total, "Süre (sn)": r.duration, "Tarih": new Date(r.date).toLocaleString("tr-TR")
    };
  });

  const matrix = buildItemMatrix(results);
  const sortedIdx = matrix.totalScores.map(function (score, i) { return { score: score, i: i }; }).sort(function (a, b) { return b.score - a.score; });
  const groupSize = Math.max(1, Math.round(sortedIdx.length * 0.27));
  const upperIdx = sortedIdx.slice(0, groupSize).map(function (o) { return o.i; });
  const lowerIdx = sortedIdx.slice(-groupSize).map(function (o) { return o.i; });

  const itemRows = [];
  for (let qi = 0; qi < matrix.k; qi++) {
    const q = matrix.refQuestions[qi];
    if (!q) continue;
    const col = matrix.correctMatrix.map(function (row) { return row[qi]; });
    const p = mean(col);
    const d = mean(upperIdx.map(function (i) { return col[i]; })) - mean(lowerIdx.map(function (i) { return col[i]; }));
    itemRows.push({
      "Soru No": qi + 1, "Soru Metni": q.text, "Zorluk (p)": p.toFixed(2), "Ayırt Edicilik (D)": d.toFixed(2),
      "Madde-Toplam Korelasyonu": pearson(col, matrix.totalScores).toFixed(2), "Durum": difficultyLabel(p) + " / " + discriminationLabel(d)
    });
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(resultRows), "Sonuçlar");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(itemRows), "Madde Analizi");
  XLSX.writeFile(wb, "sinav_sonuclari.xlsx");
}

// ---------------------------------------------------------------------------
// Admin: Öğrenci Profili (kişi bazlı, sınavlar arası)
// ---------------------------------------------------------------------------

async function loadStudentsList() {
  const res = await apiGet("getStudents", { token: adminToken });
  if (!res.success) return showToast(res.message || "Öğrenci listesi alınamadı.", "error");
  studentsCache = res.students;
  const datalist = document.getElementById("studentsList");
  datalist.innerHTML = res.students.map(function (s) { return "<option value='" + escapeHtml(s.id) + "'>" + escapeHtml(s.name) + "</option>"; }).join("");
}

async function searchStudentProfile() {
  const studentId = document.getElementById("studentSearchInput").value.trim();
  const container = document.getElementById("studentProfileContent");
  if (!studentId) return showToast("Bir öğrenci numarası girin veya seçin.", "error");

  const res = await apiGet("getStudentHistory", { studentId: studentId, adminToken: adminToken });
  if (!res.success) return showToast(res.message || "Öğrenci bulunamadı.", "error");

  const student = studentsCache.find(function (s) { return String(s.id) === studentId; });
  container.innerHTML = "";

  if (!res.history.length) {
    container.innerHTML = "<div class='empty-state'>📭 " + (student ? escapeHtml(student.name) : studentId) + " için henüz sınav sonucu yok.</div>";
    return;
  }

  const scores = res.history.map(function (h) { return h.score; });
  const header = document.createElement("div");
  header.className = "card";
  header.innerHTML =
    "<h3 style='margin-top:0;'>" + (student ? escapeHtml(student.name) : escapeHtml(studentId)) + " <small style='color:#888;'>(" + escapeHtml(studentId) + ")</small></h3>" +
    "<div class='summary-grid'>" +
    "<div class='stat-card'><h4>Katıldığı Sınav</h4><div class='stat-value'>" + res.history.length + "</div></div>" +
    "<div class='stat-card'><h4>Ortalama</h4><div class='stat-value'>" + mean(scores).toFixed(1) + "</div></div>" +
    "<div class='stat-card'><h4>En Yüksek</h4><div class='stat-value'>" + Math.max.apply(null, scores) + "</div></div>" +
    "<div class='stat-card'><h4>En Düşük</h4><div class='stat-value'>" + Math.min.apply(null, scores) + "</div></div>" +
    "</div>";
  container.appendChild(header);

  const listWrap = document.createElement("div");
  listWrap.className = "card";
  listWrap.innerHTML = "<h4>Sınav Geçmişi</h4>";
  res.history.slice().reverse().forEach(function (h) {
    const row = document.createElement("div");
    row.className = "history-row";
    row.innerHTML =
      "<div><strong>" + escapeHtml(h.examName) + "</strong><br><small>" + new Date(h.date).toLocaleString("tr-TR") + "</small></div>" +
      "<div class='history-score'>" + h.score + "</div>" +
      "<button type='button' class='btn-secondary' style='width:auto;padding:8px 16px;'>Karne Gör</button>";
    row.querySelector("button").onclick = function () {
      openModal("Sınav Karnesi — " + h.examName, renderAnswerSheetHtml(Object.assign({ studentName: student ? student.name : studentId }, h)));
    };
    listWrap.appendChild(row);
  });
  container.appendChild(listWrap);
}
