# GradeScan — Architectural Specification & Engineering Guide

## 1. System Overview

GradeScan is an **offline-first, cloud-synchronized academic grading assistant** designed for university instructors and school teachers. It automates the extraction, fuzzy matching, review, and synchronization of exam grades from scanned paper sheets directly into cloud spreadsheets (Google Sheets) and local workbooks (Excel `.xlsx`).

```
┌────────────────────────────────────────────────────────────────────────┐
│                        GRADESCAN MOBILE APP                            │
│                                                                        │
│   ┌────────────────────┐   ┌───────────────────┐   ┌────────────────┐  │
│   │ Camera / Document  │──▶│ OCR (Gemini/Tess.)│──▶│ Fuzzy Matching │  │
│   │ Scanner            │   │ (Arabic + Latin)  │   │ Levenshtein    │  │
│   └────────────────────┘   └───────────────────┘   └───────┬────────┘  │
│                                                            │           │
│                                                            ▼           │
│   ┌────────────────────┐   ┌───────────────────┐   ┌────────────────┐  │
│   │ Sync Queue Manager │◀──│ Local SQLite DB   │◀──│ Review &       │  │
│   │ (Exponential Retry)│   │ (expo-sqlite)     │   │ Verification   │  │
│   └─────────┬──────────┘   └───────────────────┘   └────────────────┘  │
└─────────────┼──────────────────────────────────────────────────────────┘
              │ HTTP JSON (Batch API)
              ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      GRADESCAN SYNCHRONIZATION API                     │
│                                                                        │
│   ┌────────────────────┐   ┌───────────────────┐   ┌────────────────┐  │
│   │ Sync Controller    │──▶│ Conflict Detector │──▶│ Sheets Service │  │
│   │ /api/sync/batch    │   │ (Cloud vs Local)  │   │ (Google APIs)  │  │
│   └────────────────────┘   └───────────────────┘   └───────┬────────┘  │
└────────────────────────────────────────────────────────────┼───────────┘
                                                             ▼
                                                    Google Sheets / Excel
```

---

## 2. Key Architecture Pillars

### 2.1 Offline-First Core
* **Zero Cloud Dependency for Core Tasks:** Teachers can create classes, import rosters, capture exams, run OCR, review grades, and confirm marks completely without an internet connection.
* **Persistent Local Database:** Backed by SQLite via `expo-sqlite`, storing classes, students, grading sessions, raw scans, extracted grades, and pending sync operations.
* **Atomic Transactions:** All grade confirmations and sync enqueue operations execute within SQLite transactions (`db.withTransactionAsync`). The same holds for a photographed page (`saveScanWithGrades`: the grading session is created together with its first page, so leaving the camera screen without a photo leaves nothing behind), for deleting a class or clearing the data (`deleteClass`, `clearAllData`, `clearSyncedOperations`), and for creating a class in attendance mode (`services/class-create.ts`: a failure removes the half-written class, and a retry replaces the student list instead of adding to it). Every **Delete Class** button (the ✕ on the Classes list, the button on the Home card, the one under each class of the Attendance list, and the one at the bottom of a class's settings) goes through one function, `services/class-delete.ts → confirmDeleteClass`: it asks first, says how many grades are not yet saved to the sheet (they are lost with the class), deletes in one transaction, and tells the screen whether the class is really gone; a second tap while the question is open is ignored.

### 2.1b Public release (any teacher, any network)
* **How it is published:** `PUBLISH.md`. The backend runs on a free Render web service (`backend/render.yaml`); the app is an Android APK built by EAS (`mobile/eas.json`, profile `preview`). `mobile/app.json` carries the package `com.gradescan.app`, the `gradescan://` sign-in link and only the camera permission (no microphone); `extra.backendUrl` / `extra.apiKey` ship the server address and the shared access key inside the app (the key is a door lock, not a secret).
* **Photo limit:** photos sent to the reader (`POST /api/ocr`) are counted per phone and per address (`backend/src/middleware/ocr-limit.ts`, `OCR_SCANS_PER_HOUR`, default 200 per phone per hour, the address bucket is 5x; memory only, so it starts empty after the free server wakes). It runs after the access-key check and before the body is read. A refused photo gets a 429 with the server's own sentence and `Retry-After`; the app shows that sentence (`services/ocr.service.ts`) instead of "check your internet".
* **Installation id:** the phone is a random id the app makes on first start and sends as `x-client-id` (`services/backend.ts → getClientId`); it holds no name or e-mail and may be missing (the server then counts by address only).

### 2.2 Synchronization Engine (`SyncManager`)
* **Operation Queue:** Verified grades create immutable `SyncOperation` records in `PENDING` state.
* **Network Awareness:** Listens to `@react-native-community/netinfo`. Automatically triggers synchronization when network connectivity transitions from offline to online.
* **Groups and retries:** The queue is sent in groups of at most `SYNC_CHUNK_SIZE` (100) grades; the server accepts at most 500 grades / 1 MB per request. The grades of every finished group are saved as `SYNCED` before the next group is sent. A failed attempt (no network, wrong access key, server error, an unreadable reply) changes nothing about the grades: they keep the reason they failed earlier and are sent again at the next sync (`FAILED` grades are part of every run), and the reason of the attempt itself is shown as `SyncProgress.message` on Home and in the Sync Queue. Only answers about grades of the group that was sent count, each once; a grade the server did not answer for stays queued and is counted as an error. Only one run exists at a time (the slot is claimed before the first `await`).
* **Conflict Resolution:** If the target cloud cell has changed since last sync, the backend flags status as `CONFLICT`, returning `cloudValue` and `localValue`. Conflicts are logged into `SyncConflict` and can be resolved manually or automatically.

### 2.3 Bilingual & Mixed Content (Arabic + English)
* **Full RTL / LTR Switching:** Integrated with `i18next` and React Native's `I18nManager` for dynamic RTL flipping.
* **Arabic OCR & Normalization:** Strips Arabic Tashkeel (diacritics: `َ ً ُ ٌ ِ ٍ ْ ّ`), normalizes Alef forms (`آ أ إ ٱ → ا`), and converts Ta Marbuta (`ة → ه`).
* **OCR Engines (backend `/api/ocr`):** Handwritten Arabic names are read by **Google Gemini** (`backend/src/services/gemini-ocr.service.ts`), chosen for its accuracy on Arabic handwriting (CER ≈ 0.13 vs ≈ 0.54 for Tesseract on the KITAB-Bench Arabic OCR benchmark). `ocr.manager.ts` picks the engine (`OCR_PROVIDER`, default `auto`) and falls back to the offline Tesseract engine (`ocr.service.ts`) when Gemini is unavailable (no key, no internet, free quota used up); the response carries `provider` / `fallbackReason` so the app can warn the teacher. Setup and privacy notes are in `backend/.env.example`.
* **Arabic Name Matching:** Roster and scanned names are folded to one spelling before comparing (diacritics, tatweel, أ/إ/آ→ا, ة→ه, ى/ئ→ي, ؤ→و, "عبد الله"→"عبدالله"), and the roster is re-normalised at match time so rosters imported before a rule change still match.
* **Bilingual Grade Parsing:** Handles numeric and fraction formats in both languages (e.g. `17/20`, `17 من 20`, `الدرجة: 18.5`, `Mark: 19`).
* **Fuzzy Matching Pipeline (`matching.service.ts`):** Arabic-aware normalization (أإآ→ا, ة→ه, ى→ي, diacritics), then an **order-aware word alignment** (longest common subsequence) between the scanned name and every roster name, so a name that merely shares common words (احمد, محمد) with another student's lineage is not confused with it. Words of five or more letters may differ slightly (a misread letter); shorter words must match exactly. Results are `high_confidence` (≥85%), `needs_review` (65–84%, capped at 84% whenever two students are almost equally plausible) and `unmatched` (<65%). The review screen's search uses the same normalization (`nameMatchesQuery`), so أبراهيم finds ابراهيم.

### 2.4 Spreadsheet Ingestion
* **Google Sheets — one sheet, by link, opened by the server's own Google account.** The teacher pastes a sheet's link; nothing else of theirs is ever requested. All Sheets access goes through the backend's **service account** (the "robot", `services/google-auth.ts`: `service-account.json`, `GOOGLE_SERVICE_ACCOUNT_PATH` or inline `GOOGLE_SERVICE_ACCOUNT_JSON`; its e-mail is the `client_email` in that key). The robot can open only the sheets whose owner shared them with its e-mail, so the teacher's Google account, Drive and other sheets stay out of reach, and **no Google session of the teacher is used for reading, analysing or saving** (the request carries only the optional `x-api-key`).
  * **Read** (`spreadsheet.service.ts` on the phone): `fetchViaServer` calls `GET /api/spreadsheet/:id/workbook` (the robot reads every worksheet with its cell values); if the sheet is not shared with the robot, or the server has no key, it falls back to `fetchPublicWorkbook` (the public `export?format=xlsx`, with a CSV `gviz` fallback) for sheets shared as "Anyone with the link can view". When that fallback is used the result carries `meta.warning` and the Connect screen explains that saving needs the sheet shared with the robot's e-mail (shown in a box with the address, and under Settings → TEST).
  * **Write** (`/api/sync/batch` → `sync.service.ts` → `google-sheets.service.ts`): the robot updates the graded cell with the same conflict check as before. A sheet that is not shared with it fails with a plain-language message (`google-errors.ts`: 403/404 → "share the sheet with <robot e-mail> as Editor"; the JSON also carries `serviceAccountEmail`), and the operation stays `FAILED` until the teacher shares the sheet and taps RETRY FAILED. A server without a key answers `503` with `notConfigured: true`. `/health` (callers with a valid key only) reports `googleSheets` and `serviceAccountEmail`.
  * **"Continue with Google" identifies the teacher and carries the Drive permission.** It is an OAuth authorization-code flow run by the backend (which alone holds the client secret) with scopes `openid email profile` plus, on the same Google page, the per-file `drive.file` scope (the app always sends `&drive=1`): the app asks `GET /api/auth/google/url?return=<app link>` for the Google address (the server signs an expiring `state`; the return link must be an app link) and opens it in the browser. Google returns either (a) to the server's own `GET /auth/google/callback` (hosted server) or (b) in **relay mode** (`GOOGLE_REDIRECT_URI` set — server on a PC, where Google refuses an `http://192.168…` address) to a static page on GitHub Pages (`auth-relay/callback.html`, no secrets) that forwards the one-time `code` + `state` to the app (`gradescan://` or Expo Go's `exp://`); the app swaps them for the token with `POST /api/auth/google/exchange`, so the token never travels in a URL. The server verifies the id token and returns the verified **e-mail and name**; the refresh token is kept on the phone as proof of sign-in and, when Google really granted the Drive scope, as the permission for creating attendance sheets. It is not sent with sheet requests. The Drive scope `https://www.googleapis.com/auth/drive.file` is non-sensitive (only files the app creates); `GET /api/auth/google/url?…&drive=1` (or `/auth/google/start?…&drive=1`) adds it, `exchangeCode` reports `driveGranted` from the scopes Google really granted (the teacher can untick the line; the sign-in then still works and the old Drive token is dropped), and `completeSignIn` stores the token for Drive too (`services/google-drive-access.ts`, settings `googleDriveRefreshToken` / `googleDriveEmail`; always the same value as the sign-in token; a sign-in without Drive calls `forgetDriveAccess()`). There is **no separate "Allow Google Drive" trip, button or link anywhere**: Google's sign-in page is the only place the permission is asked, and signing out and in again is the only way to give it later (the server logs `[Drive allowed]` / `[Drive NOT allowed: …]` per sign-in). It is sent (header `x-google-refresh-token`) only with `create-attendance`, and Sign out forgets and revokes it.
* **Excel (.xlsx):** In-app parsing and generation using `xlsx` (SheetJS). Teachers can load bilingual Excel templates, select worksheets, and auto-detect name, ID, and grade columns.

### 2.5 Sign-in and Terms Gate
* **One door into the app.** On start `AppNavigator` opens **Home** only when there is an active account **and** the current terms were accepted; otherwise **SignIn**. The sign-in page (`SignInScreen.tsx`) makes the person (1) tick *I agree* to the Terms of Use and Privacy Notice, which open in `TermsScreen.tsx` (English/Arabic, text in `src/legal/index.ts`, maker: Eng Atta), and (2) sign in with Google. The agreement is stored (`termsAcceptedVersion`, `termsAcceptedAt` in `AppSettings`, `services/terms.ts`) *before* Google opens, so the app is never entered without it. `TERMS_VERSION` changes ask everyone again.
* **Google = the account.** `AuthService.signInWithGoogle()` runs the OAuth flow of 2.4 (scopes `openid email profile` only); the server verifies the id token and returns the verified **e-mail and name**. The app finds or creates the matching `UserAccount` row (`authProvider='google'`, no password) and makes it active. An older e-mail/password account with the same address is converted. **Sign out** leaves the app *and* revokes the Google sign-in, then returns to SignIn. Because the account never carries Sheets access, signing in or out does not change what the app can do with a sheet.
* **Guest.** *Continue without an account (offline)* uses the fixed `local` account. It needs the same agreement; sheets work for it exactly as for a signed-in teacher.
* **Existing data.** `adoptUnownedClasses()` gives classes that nobody owns (no owner, the guest's, old e-mail accounts', orphans) to the account that signs in; classes owned by a Google account are never moved.

### 2.6 Attendance Mode
A names-only scanning mode, reached from **Home → TAKE ATTENDANCE** (Home shows two named cards: **SCAN GRADES** and **TAKE ATTENDANCE**; the grades card needs a class with a grade column, so Home prefers one over classes made by the attendance mode and explains when the selected class has none) (`AttendanceStartScreen`). It reuses the camera, the OCR manager and the fuzzy matcher, but never reads grades.
* **Reading names.** `POST /api/ocr` with `mode: 'names'` returns only the names on the page (`ocrManager.recognizeNames`: Gemini with a names-only prompt, Tesseract fallback). `services/ocr.service.ts → processNames` calls it. Every photo is one page; `MatchingService.matchStudents` runs per page against the class roster (≥ 85 % present automatically, 65–84 % needs review, < 65 % unmatched) and `services/attendance.ts` merges the pages in an **in-memory attendance session** (`startAttendanceSession`, `addDetections`, `getAttendanceSession`, `clearAttendanceSession`), flagging a student seen on two pages. Nothing is persisted until the teacher confirms on `AttendanceReviewScreen`.
* **Two flows.**
  * `flow: 'existing'` — `AttendanceSetupScreen`: the teacher pastes a sheet link; the server reads it through the robot (the same `GET /api/spreadsheet/:id/workbook` as grading; when the sheet could only be read through the public export, `SpreadsheetService.getLayout` returns `readOnly: true` and the screen shows the robot's e-mail with **CHECK AGAIN** instead of continuing), the teacher picks the worksheet, the name column and the **tick column** (an existing header or **+ NEW COLUMN**, default title `todayKey()`). The roster is saved as a normal `Class` (a sheet+worksheet that already has a class is reused and keeps its grade column), so later days start straight at the camera (`openAttendanceForClass`).
  * `flow: 'first'` — `AttendanceFirstTimeScreen`: the names on the first photo become the roster. Target **sheet** → the Drive permission is normally already there from the sign-in (`components/DriveAccessCard.tsx` only shows ✓ and the account, or says that the Drive box was not ticked and how to fix it; choosing the sheet without the permission is refused before the camera opens; on the review screen, when the permission is missing or has run out, the failure box offers **SAVE THE LIST IN THE APP INSTEAD** (`keepInApp` → local class, no network), so the scanned names are never lost); then `POST /api/spreadsheet/create-attendance` (with the teacher's Drive token in `x-google-refresh-token`) makes a new sheet **in the teacher's own Drive** (names in column A, the day in column B, bold frozen header) through an OAuth client built from that token (`google-oauth.service.ts → createUserAuthClient`; `google-sheets.service.ts → createAttendanceSheet`; the file is created through the Drive API first with the Sheets API's own create as the second try; a sheet whose content cannot be written is deleted again; the error shown to the teacher quotes Google's reason). Afterwards the robot (service account) is added as Editor (non-fatal: the response says `sharedWithRobot` and, if false, the result card shows the robot's e-mail to add by hand), so later days are ticked by the robot through `POST /api/spreadsheet/:id/attendance`. A missing / expired / insufficient token answers `403 drive_permission_needed` ("Sign out in Settings, sign in with Google again and keep the Google Drive box ticked. Or save the list in the app…") and the phone forgets it; target **app** → a `spreadsheetType = 'local'` class and rows in `AttendanceRecord`.
* **Writing the ticks.** For online sheets `POST /api/spreadsheet/:id/attendance` (`markAttendance`) takes the worksheet, the tick column, the header row, the new column title (optional) and the rows to mark. It reads the column first and writes `✓` **only into empty cells**; non-empty cells are returned as `skipped`, a new column whose header cell holds a different title is refused (`409 header_conflict`), and inputs are validated (`AttendanceInputError`, row/size limits). Names, titles and e-mails are written as literal text (`asLiteralText`), so a name starting with `=` is never a formula. The robot's only scope is `spreadsheets` (`google-auth.ts`); it never creates files itself. A sheet created in the teacher's Drive (`create-attendance`) is made with the teacher's own `drive.file` token, and the robot is then added to it as Editor (a failed share is not fatal: the response says `sharedWithRobot: false` + `shareWarning`).
* **Local classes and Excel.** Local days are rows of `AttendanceRecord(classId, studentId, columnTitle)`; `services/attendance-export.ts` builds an `.xlsx` with SheetJS (name column, one column per day, Total) and hands it to `expo-sharing`, which is an optional dependency loaded with `require` in a try/catch (the app explains how to install it if it is missing).
* **Classes without a grade column.** A class made by the attendance mode has `gradeColumn` / `gradeColumnIndex` = `NULL`. Home and Classes show **TAKE ATTENDANCE** for it, and the grading paths (`ScanScreen`, `ReviewScreen.doSave`) refuse a class without a grade column instead of writing to a wrong cell.
* **Errors.** `google-errors.ts` turns Google's failures into plain sentences (sheet not shared, Drive API disabled, the teacher's Drive full, quota); `isUserTokenProblem` recognises an expired / revoked / under-scoped teacher token (→ `drive_permission_needed`). The review screen keeps the detections on any failure so the teacher can fix the cause and tap SAVE again.

---

## 3. Database Schema (SQLite)

```sql
-- Classes
-- (The grade columns are NULL for classes made by the attendance mode.)
CREATE TABLE Class (
  id TEXT PRIMARY KEY,
  userId TEXT DEFAULT 'local',
  name TEXT NOT NULL,
  spreadsheetId TEXT,
  spreadsheetType TEXT DEFAULT 'google', -- 'google' | 'excel' | 'local' (kept in the app, attendance mode)
  worksheetId TEXT,
  worksheetName TEXT,
  studentNameColumn TEXT,
  studentIdColumn TEXT,
  gradeColumn TEXT,
  gradeColumnIndex INTEGER,
  lastSyncedAt TEXT,
  createdAt TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Students
CREATE TABLE Student (
  id TEXT PRIMARY KEY,
  classId TEXT NOT NULL,
  externalStudentId TEXT,
  name TEXT NOT NULL,
  normalizedName TEXT NOT NULL,
  spreadsheetRow INTEGER NOT NULL,
  additionalData TEXT,
  createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (classId) REFERENCES Class(id) ON DELETE CASCADE
);

-- Grading Sessions
CREATE TABLE GradingSession (
  id TEXT PRIMARY KEY,
  classId TEXT NOT NULL,
  gradeColumn TEXT,
  totalScanned INTEGER DEFAULT 0,
  totalApproved INTEGER DEFAULT 0,
  totalSynced INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active', -- 'active' | 'completed' | 'abandoned'
  createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (classId) REFERENCES Class(id) ON DELETE CASCADE
);

-- Individual Page Scans
CREATE TABLE Scan (
  id TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL,
  pageNumber INTEGER NOT NULL,
  ocrText TEXT,
  imageReference TEXT,
  createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (sessionId) REFERENCES GradingSession(id) ON DELETE CASCADE
);

-- Extracted Grades from Scans
CREATE TABLE ExtractedGrade (
  id TEXT PRIMARY KEY,
  scanId TEXT NOT NULL,
  studentId TEXT,
  detectedName TEXT,
  detectedGrade REAL,
  maxGrade REAL,
  nameConfidence REAL,
  gradeConfidence REAL,
  matchConfidence REAL,
  status TEXT DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected' | 'ignored'
  FOREIGN KEY (scanId) REFERENCES Scan(id) ON DELETE CASCADE,
  FOREIGN KEY (studentId) REFERENCES Student(id) ON DELETE SET NULL
);

-- Synchronization Queue
CREATE TABLE SyncOperation (
  id TEXT PRIMARY KEY,
  classId TEXT NOT NULL,
  studentId TEXT NOT NULL,
  spreadsheetId TEXT NOT NULL,
  worksheetId TEXT NOT NULL,
  targetColumn TEXT NOT NULL,
  targetColumnIndex INTEGER NOT NULL,
  targetRow INTEGER NOT NULL,
  oldValue REAL,
  newValue REAL NOT NULL,
  status TEXT NOT NULL, -- 'PENDING' | 'SYNCING' | 'SYNCED' | 'FAILED' | 'CONFLICT' | 'CANCELLED'
  retryCount INTEGER DEFAULT 0,
  createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
  lastAttemptAt TEXT,
  errorMessage TEXT,
  sessionId TEXT -- the grading session the grade came from (NULL for grades saved by older versions)
);
-- Databases made by older versions get the sessionId column on first start (database/index.ts: PRAGMA table_info + ALTER TABLE ADD COLUMN; existing rows are kept).
-- History counts a session's synced grades from sessionId; "Clear synced" first adds the finished rows to GradingSession.totalSynced, so the count survives.

-- Sync Conflicts
CREATE TABLE SyncConflict (
  id TEXT PRIMARY KEY,
  syncOperationId TEXT NOT NULL,
  localValue REAL NOT NULL,
  cloudValue REAL NOT NULL,
  studentName TEXT,
  resolvedAt TEXT,
  resolution TEXT,
  FOREIGN KEY (syncOperationId) REFERENCES SyncOperation(id) ON DELETE CASCADE
);

-- Attendance mode: one row per student who was present on one day
-- (the day = the title of the column, e.g. '2026-10-29'; absent students have no row)
CREATE TABLE AttendanceRecord (
  id TEXT PRIMARY KEY,
  classId TEXT NOT NULL,
  studentId TEXT NOT NULL,
  columnTitle TEXT NOT NULL,
  mark TEXT DEFAULT '✓',
  createdAt TEXT DEFAULT (datetime('now')),
  UNIQUE (classId, studentId, columnTitle)
);
CREATE INDEX idx_attendance_classId ON AttendanceRecord(classId);
```

---

## 4. Vintage Academic Design System

The application adheres to a **vintage academic grade book aesthetic**:
* **Color Palette:**
  * Background: `#F9F6F0` (Warm Ivory)
  * Surface: `#F4EFE6` (Pressed Parchment)
  * Accents: `#B49F7A` (Antique Brass / Gold)
  * Ink / Text: `#2C211A` (Espresso ink) & `#1D1A17` (Deep ink)
  * Status Marks: `#4A6B53` (Sage Olive), `#8C3B3B` (Burgundy stamp), `#B3822A` (Amber)
* **Typography:** Classic Georgia serif headers with letterspaced titles and decorative page rules.
* **Component Styling:** Card borders mimic pressed heavy cardstock with subtle ink borders and stamp badges.

---

## 5. Development & Testing Commands

### Backend
```bash
cd backend
npm install
npx tsc               # Compiles TypeScript to dist/
node dist/index.js    # Starts API on port 3000
```

### Mobile
```bash
cd mobile
npm install
npx tsc --noEmit      # Verify TypeScript types
npx expo start        # Start Metro bundler (press 'w' for web, or scan QR for iOS/Android)
```

### Tests (from the repository root)
```bash
npm install           # installs the test runner (tsx)
npm test              # every suite: backend (OAuth, Sheets, attendance, Gemini, security, HTTP API), mobile (Google, auth, attendance, matching, grade parser, database, sync manager, class creation, review helpers, i18n) and the relay page
npm test -- database  # only the suites whose name contains the word
npm run typecheck     # tsc --noEmit for backend and mobile
```

**Two kinds of test, never mixed up.** `npm test` runs *isolated* tests: they replace Google, Gemini, the phone's database and the screens' data layer with local stand-ins so the logic can be checked in seconds. A passing isolated test says the code is correct against the stand-in, **not** that the real service works. The *live check* is the other kind:

```bash
# start your real backend first (cd backend && npm run dev), then from the repository root:
npm run test:real                 # real backend + real Google (nothing is simulated); needs no test data at all
# optional: also read and write ONE scratch cell of a sheet you designated for testing (shared with the robot as Editor):
REAL_TEST_SHEET=<link> REAL_TEST_WRITE=yes REAL_TEST_CELL=Sheet1!Z100 npm run test:real     # PowerShell: $env:REAL_TEST_SHEET="..."; ...
```
It checks that the backend answers, the access key is enforced, the robot key really gets a token from Google, Google accepts the sign-in settings, the sign-in page published on GitHub is the current one, and that a sheet Google cannot open is reported as FAILED (never SYNCED). With the optional variables it reads the test sheet, writes one number into the EMPTY scratch cell, reads it back from Google and clears that cell again. It prints PASS, FAIL or SKIP (SKIP means not checked, never success) and exits with 1 on any FAIL. The phone's own database, the sign-in itself (needs a person) and the attendance sheet creation in a teacher's Drive cannot be automated and must be checked by hand on the phone.
The mobile database suites run the app's real `database/index.ts` and `queries.ts` on Node's built-in SQLite (Node 22.5+; foreign keys ON), so they check the real SQL, the sessionId upgrade of an old database and the all-or-nothing behaviour. Nothing touches real Google, Gemini or your data. The relay-page suite and the `screens` suite (the app's own Classes, History, Sync queue and Home screens bundled with react-native-web and opened in Chromium, in English and Arabic, with the database and sync manager replaced by switchable fakes: error states with Retry, the warning before deleting a class with unsaved grades, accessible names, translated status lines) need Playwright's Chromium (and `screens` also needs esbuild, installed by `npm install` in the root); each is reported as SKIPPED (never as passed) when something it needs is missing.
