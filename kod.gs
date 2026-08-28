/**
 * ODYS - Online Değerlendirme ve Sınav Sistemi
 * Backend (Google Apps Script) — v3
 *
 * v3 DEĞİŞİKLİKLERİ:
 * - Soru düzenleme (updateQuestion) ve sınav düzenleme (updateExam) eklendi
 * - Öğrenciler için de admin'e benzer oturum token'ı eklendi (submitExam ve
 *   getStudentHistory artık kimliği doğrulanmış öğrenciye veya admin'e özel —
 *   önceden herkes başka birinin öğrenci no'sunu bilerek not geçmişini görebilir
 *   ya da sahte sonuç gönderebilirdi)
 * - getStudents: admin'in tüm öğrencileri görüp profil raporuna bakabilmesi için
 * - getStudentHistory artık cevap/soru detayını da döndürüyor (kişi bazlı karne için)
 * - getResults artık öğrenci adını da eşleştirip döndürüyor
 */

const SPREADSHEET_ID = SpreadsheetApp.getActiveSpreadsheet().getId();
const ADMIN_TOKEN_TTL_SECONDS = 7200;    // 2 saat
const STUDENT_TOKEN_TTL_SECONDS = 10800; // 3 saat (sınav süresi + tampon)
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_SECONDS = 300;

// ---------------------------------------------------------------------------
// Yardımcı fonksiyonlar
// ---------------------------------------------------------------------------

function getSS() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function ok(extra) {
  return jsonOut(Object.assign({ success: true }, extra || {}));
}

function fail(message, extra) {
  return jsonOut(Object.assign({ success: false, message: message }, extra || {}));
}

function getOrCreateSheet(name, headers) {
  const ss = getSS();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (headers && headers.length) sheet.appendRow(headers);
  }
  return sheet;
}

function makeSalt() {
  return Utilities.getUuid().replace(/-/g, "").substring(0, 16);
}

function hashPassword(password, salt) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(salt) + String(password));
  return bytes.map(function (b) { return (b < 0 ? b + 256 : b).toString(16).padStart(2, "0"); }).join("");
}

function verifyPassword(inputPassword, storedValue, storedSalt) {
  if (!storedSalt) return String(inputPassword) === String(storedValue);
  return hashPassword(inputPassword, storedSalt) === storedValue;
}

function generateAdminToken() {
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put("admin_" + token, "1", ADMIN_TOKEN_TTL_SECONDS);
  return token;
}

function isValidAdminToken(token) {
  if (!token) return false;
  return CacheService.getScriptCache().get("admin_" + token) === "1";
}

function requireAdmin(token) {
  if (!isValidAdminToken(token)) throw new Error("Yetkisiz erişim. Lütfen tekrar giriş yapın.");
}

function generateStudentToken(studentId) {
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put("student_" + token, String(studentId), STUDENT_TOKEN_TTL_SECONDS);
  return token;
}

function isValidStudentToken(token, studentId) {
  if (!token) return false;
  return CacheService.getScriptCache().get("student_" + token) === String(studentId);
}

function requireOwnerOrAdmin(studentToken, adminToken, studentId) {
  if (isValidAdminToken(adminToken)) return;
  if (isValidStudentToken(studentToken, studentId)) return;
  throw new Error("Yetkisiz erişim.");
}

function isLockedOut(username) {
  const attempts = Number(CacheService.getScriptCache().get("login_fail_" + username) || 0);
  return attempts >= MAX_LOGIN_ATTEMPTS;
}

function registerFailedLogin(username) {
  const cache = CacheService.getScriptCache();
  const key = "login_fail_" + username;
  cache.put(key, String(Number(cache.get(key) || 0) + 1), LOGIN_LOCKOUT_SECONDS);
}

function clearFailedLogins(username) {
  CacheService.getScriptCache().remove("login_fail_" + username);
}

// ---------------------------------------------------------------------------
// doPost / doGet yönlendirme
// ---------------------------------------------------------------------------

function doPost(e) {
  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return fail("Geçersiz istek gövdesi.");
  }

  const handlers = {
    adminLogin: handleAdminLogin,
    studentLogin: handleStudentLogin,
    registerStudent: handleRegisterStudent,
    createExam: handleCreateExam,
    updateExam: handleUpdateExam,
    toggleExamActive: handleToggleExamActive,
    deleteExam: handleDeleteExam,
    addBulkQuestions: handleAddBulkQuestions,
    updateQuestion: handleUpdateQuestion,
    deleteQuestion: handleDeleteQuestion,
    submitExam: handleSubmitExam
  };

  const handler = handlers[data.action];
  if (!handler) return fail("Bilinmeyen işlem: " + data.action);

  try {
    return handler(data);
  } catch (err) {
    return fail(err.message);
  }
}

function doGet(e) {
  const handlers = {
    getExams: handleGetExams,
    getQuestions: handleGetQuestions,
    getResults: handleGetResults,
    getStudentHistory: handleGetStudentHistory,
    getStudents: handleGetStudents
  };

  const handler = handlers[e.parameter.action];
  if (!handler) return fail("Bilinmeyen işlem: " + e.parameter.action);

  try {
    return handler(e.parameter);
  } catch (err) {
    return fail(err.message);
  }
}

// ---------------------------------------------------------------------------
// Kimlik doğrulama
// ---------------------------------------------------------------------------

function handleAdminLogin(data) {
  const username = String(data.user || "").trim();
  if (isLockedOut(username)) {
    return fail("Çok fazla hatalı deneme yapıldı. Lütfen " + Math.round(LOGIN_LOCKOUT_SECONDS / 60) + " dakika sonra tekrar deneyin.");
  }
  const sheet = getOrCreateSheet("Kullanicilar", ["Kullanici", "ParolaHash", "Salt"]);
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === username) {
      const storedValue = rows[i][1], storedSalt = rows[i][2];
      if (verifyPassword(data.pass, storedValue, storedSalt)) {
        if (!storedSalt) {
          const salt = makeSalt();
          sheet.getRange(i + 1, 2, 1, 2).setValues([[hashPassword(data.pass, salt), salt]]);
        }
        clearFailedLogins(username);
        return ok({ token: generateAdminToken() });
      }
      break;
    }
  }
  registerFailedLogin(username);
  return fail("Kullanıcı adı veya parola hatalı.");
}

function handleStudentLogin(data) {
  const studentId = String(data.studentId || "").trim();
  if (isLockedOut(studentId)) {
    return fail("Çok fazla hatalı deneme yapıldı. Lütfen " + Math.round(LOGIN_LOCKOUT_SECONDS / 60) + " dakika sonra tekrar deneyin.");
  }
  const sheet = getOrCreateSheet("Ogrenciler", ["ÖğrenciNo", "AdSoyad", "ParolaHash", "Salt"]);
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === studentId) {
      const storedValue = rows[i][2], storedSalt = rows[i][3];
      if (verifyPassword(data.password, storedValue, storedSalt)) {
        if (!storedSalt) {
          const salt = makeSalt();
          sheet.getRange(i + 1, 3, 1, 2).setValues([[hashPassword(data.password, salt), salt]]);
        }
        clearFailedLogins(studentId);
        return ok({ studentName: rows[i][1], token: generateStudentToken(studentId) });
      }
      break;
    }
  }
  registerFailedLogin(studentId);
  return fail("Öğrenci numarası veya şifre hatalı.");
}

function handleRegisterStudent(data) {
  const studentId = String(data.studentId || "").trim();
  const name = String(data.name || "").trim();
  const password = String(data.password || "");
  if (!studentId || !name || password.length < 4) {
    return fail("Öğrenci numarası, ad soyad ve en az 4 karakterli bir şifre girmelisiniz.");
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getOrCreateSheet("Ogrenciler", ["ÖğrenciNo", "AdSoyad", "ParolaHash", "Salt"]);
    const rows = sheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][0]) === studentId) return fail("Bu öğrenci numarası zaten kayıtlı.");
    }
    const salt = makeSalt();
    sheet.appendRow([studentId, name, hashPassword(password, salt), salt]);
    return ok();
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Sınav yönetimi (admin)
// ---------------------------------------------------------------------------

function handleCreateExam(data) {
  requireAdmin(data.token);
  const name = String(data.name || "").trim();
  if (!name) return fail("Sınav adı boş olamaz.");
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getOrCreateSheet("Sinavlar", ["ID", "Ad", "OlusturmaTarihi", "SureDk", "Aktif", "Baslangic", "Bitis"]);
    const id = "EX" + Utilities.getUuid().substring(0, 8);
    sheet.appendRow([id, name, new Date(), Number(data.durationMinutes) || 0, true, data.startDate || "", data.endDate || ""]);
    return ok({ id: id });
  } finally {
    lock.releaseLock();
  }
}

function handleUpdateExam(data) {
  requireAdmin(data.token);
  const sheet = getOrCreateSheet("Sinavlar");
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === data.examId) {
      const name = String(data.name || "").trim();
      if (!name) return fail("Sınav adı boş olamaz.");
      sheet.getRange(i + 1, 2, 1, 5).setValues([[
        name, rows[i][2], Number(data.durationMinutes) || 0, data.startDate || "", data.endDate || ""
      ]]);
      return ok();
    }
  }
  return fail("Sınav bulunamadı.");
}

function handleToggleExamActive(data) {
  requireAdmin(data.token);
  const sheet = getOrCreateSheet("Sinavlar");
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === data.examId) {
      const current = rows[i][4];
      sheet.getRange(i + 1, 5).setValue(!current);
      return ok({ isActive: !current });
    }
  }
  return fail("Sınav bulunamadı.");
}

function handleDeleteExam(data) {
  requireAdmin(data.token);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const examSheet = getOrCreateSheet("Sinavlar");
    const examRows = examSheet.getDataRange().getValues();
    let examRowIndex = -1;
    for (let i = 1; i < examRows.length; i++) {
      if (examRows[i][0] === data.examId) { examRowIndex = i + 1; break; }
    }
    if (examRowIndex === -1) return fail("Sınav bulunamadı.");
    examSheet.deleteRow(examRowIndex);

    const qSheet = getOrCreateSheet("Sorular");
    const qRows = qSheet.getDataRange().getValues();
    for (let i = qRows.length - 1; i >= 1; i--) {
      if (qRows[i][0] === data.examId) qSheet.deleteRow(i + 1);
    }
    return ok();
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Soru yönetimi (admin)
// ---------------------------------------------------------------------------

function handleAddBulkQuestions(data) {
  requireAdmin(data.token);
  if (!Array.isArray(data.questions) || !data.questions.length) return fail("Eklenecek soru bulunamadı.");
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getOrCreateSheet("Sorular", ["SinavID", "Tip", "Soru", "A", "B", "C", "D", "E", "Dogru"]);
    const rowsToAdd = data.questions.map(function (q) {
      const opts = q.opts || [];
      return [data.examId, "test", q.text, opts[0] || "", opts[1] || "", opts[2] || "", opts[3] || "", opts[4] || "", q.correct];
    });
    sheet.getRange(sheet.getLastRow() + 1, 1, rowsToAdd.length, 9).setValues(rowsToAdd);
    return ok({ count: rowsToAdd.length });
  } finally {
    lock.releaseLock();
  }
}

function handleUpdateQuestion(data) {
  requireAdmin(data.token);
  const sheet = getOrCreateSheet("Sorular");
  const rows = sheet.getDataRange().getValues();
  let matchCount = -1;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === data.examId) {
      matchCount++;
      if (matchCount === Number(data.questionIndex)) {
        const opts = data.opts || [];
        sheet.getRange(i + 1, 3, 1, 7).setValues([[
          data.text, opts[0] || "", opts[1] || "", opts[2] || "", opts[3] || "", opts[4] || "", data.correct
        ]]);
        return ok();
      }
    }
  }
  return fail("Soru bulunamadı.");
}

function handleDeleteQuestion(data) {
  requireAdmin(data.token);
  const sheet = getOrCreateSheet("Sorular");
  const rows = sheet.getDataRange().getValues();
  let matchCount = -1;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === data.examId) {
      matchCount++;
      if (matchCount === Number(data.questionIndex)) {
        sheet.deleteRow(i + 1);
        return ok();
      }
    }
  }
  return fail("Soru bulunamadı.");
}

// ---------------------------------------------------------------------------
// Sınav çözme (öğrenci)
// ---------------------------------------------------------------------------

function handleSubmitExam(data) {
  const studentId = String(data.studentId || "");
  const examId = String(data.examId || "");
  if (!studentId || !examId) return fail("Eksik bilgi.");
  if (!isValidStudentToken(data.token, studentId)) return fail("Oturumunuz geçersiz. Lütfen tekrar giriş yapın.");

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const answerSheet = getOrCreateSheet("Cevaplar", [
      "OgrenciNo", "Puan", "Toplam", "Dogru", "Yanlis", "Bos", "SureSn", "Tarih", "Cevaplar", "SinavID", "SorularSnapshot"
    ]);

    const existing = answerSheet.getDataRange().getValues();
    for (let i = 1; i < existing.length; i++) {
      if (String(existing[i][0]) === studentId && String(existing[i][9]) === examId) {
        return fail("Bu sınavı daha önce tamamladınız.", { alreadySubmitted: true });
      }
    }

    const qSheet = getOrCreateSheet("Sorular");
    const qRows = qSheet.getDataRange().getValues();
    const questions = qRows.slice(1).filter(function (r) { return String(r[0]) === examId; }).map(function (r) {
      return { text: r[2], opts: [r[3], r[4], r[5], r[6], r[7]], correct: r[8] };
    });
    if (!questions.length) return fail("Sınav soruları bulunamadı.");

    const answers = Array.isArray(data.answers) ? data.answers : [];
    let correct = 0, blank = 0;
    questions.forEach(function (q, i) {
      const given = answers[i];
      if (given === null || given === undefined || given === "") blank++;
      else if (String(given) === String(q.correct)) correct++;
    });
    const total = questions.length;
    const wrong = total - correct - blank;
    const score = total > 0 ? Math.round((correct / total) * 10000) / 100 : 0;

    answerSheet.appendRow([
      studentId, score, total, correct, wrong, blank,
      Number(data.duration) || 0, new Date(), JSON.stringify(answers), examId, JSON.stringify(questions)
    ]);
    return ok({ score: score, total: total, correct: correct, wrong: wrong, blank: blank });
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Okuma işlemleri
// ---------------------------------------------------------------------------

function handleGetExams(params) {
  const sheet = getOrCreateSheet("Sinavlar");
  const rows = sheet.getDataRange().getValues();
  const isAdmin = params.scope === "admin" && isValidAdminToken(params.token);
  const now = new Date();

  const exams = rows.slice(1).map(function (r) {
    return {
      id: r[0], name: r[1], durationMinutes: Number(r[3]) || 0,
      isActive: r[4] !== false, startDate: r[5] || "", endDate: r[6] || ""
    };
  }).filter(function (ex) {
    if (isAdmin) return true;
    if (!ex.isActive) return false;
    if (ex.startDate && now < new Date(ex.startDate)) return false;
    if (ex.endDate && now > new Date(ex.endDate)) return false;
    return true;
  });

  return ok({ exams: exams });
}

function handleGetQuestions(params) {
  const sheet = getOrCreateSheet("Sorular");
  const rows = sheet.getDataRange().getValues();
  const includeAnswer = params.scope === "admin" && isValidAdminToken(params.token);

  const questions = rows.slice(1).filter(function (r) { return String(r[0]) === params.examId; }).map(function (r) {
    const q = { text: r[2], opts: [r[3], r[4], r[5], r[6], r[7]] };
    if (includeAnswer) q.correct = r[8];
    return q;
  });
  return ok({ questions: questions });
}

function handleGetResults(params) {
  requireAdmin(params.token);
  const sheet = getOrCreateSheet("Cevaplar");
  const rows = sheet.getDataRange().getValues();
  const results = rows.slice(1).filter(function (r) { return String(r[9]) === params.examId; }).map(function (r) {
    return {
      studentId: r[0], score: r[1], total: r[2], correct: r[3], wrong: r[4], blank: r[5],
      duration: r[6], date: r[7], answers: JSON.parse(r[8] || "[]"), questions: JSON.parse(r[10] || "[]")
    };
  });

  const studentSheet = getOrCreateSheet("Ogrenciler");
  const studentRows = studentSheet.getDataRange().getValues();
  const nameMap = {};
  for (let i = 1; i < studentRows.length; i++) nameMap[String(studentRows[i][0])] = studentRows[i][1];
  results.forEach(function (r) { r.studentName = nameMap[String(r.studentId)] || r.studentId; });

  return ok({ results: results });
}

function handleGetStudentHistory(params) {
  const studentId = String(params.studentId || "");
  requireOwnerOrAdmin(params.token, params.adminToken, studentId);

  const sheet = getOrCreateSheet("Cevaplar");
  const rows = sheet.getDataRange().getValues();
  const history = rows.slice(1).filter(function (r) { return String(r[0]) === studentId; }).map(function (r) {
    return {
      score: r[1], total: r[2], correct: r[3], wrong: r[4], blank: r[5], duration: r[6],
      date: r[7], answers: JSON.parse(r[8] || "[]"), examId: r[9], questions: JSON.parse(r[10] || "[]")
    };
  });

  const examSheet = getOrCreateSheet("Sinavlar");
  const examRows = examSheet.getDataRange().getValues();
  const nameMap = {};
  for (let i = 1; i < examRows.length; i++) nameMap[String(examRows[i][0])] = examRows[i][1];
  history.forEach(function (h) { h.examName = nameMap[String(h.examId)] || h.examId; });

  return ok({ history: history });
}

function handleGetStudents(params) {
  requireAdmin(params.token);
  const sheet = getOrCreateSheet("Ogrenciler");
  const rows = sheet.getDataRange().getValues();
  const students = rows.slice(1).map(function (r) { return { id: r[0], name: r[1] }; });
  return ok({ students: students });
}

// ---------------------------------------------------------------------------
// Tek seferlik bakım fonksiyonu (Apps Script editöründen elle çalıştırın)
// ---------------------------------------------------------------------------

function migratePlainTextPasswords() {
  const ss = getSS();
  const admin = ss.getSheetByName("Kullanicilar");
  if (admin) {
    const rows = admin.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][1] && !rows[i][2]) {
        const salt = makeSalt();
        admin.getRange(i + 1, 2, 1, 2).setValues([[hashPassword(rows[i][1], salt), salt]]);
      }
    }
  }
  const students = ss.getSheetByName("Ogrenciler");
  if (students) {
    const rows = students.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][2] && !rows[i][3]) {
        const salt = makeSalt();
        students.getRange(i + 1, 3, 1, 2).setValues([[hashPassword(rows[i][2], salt), salt]]);
      }
    }
  }
  Logger.log("Parola geçişi tamamlandı.");
}
