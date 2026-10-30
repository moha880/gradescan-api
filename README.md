# GradeScan

A production-quality offline-first academic grading assistant mobile application.

## Project Structure

This is a monorepo containing:
- `/mobile` - The React Native (Expo) mobile application.
- `/backend` - The Node.js Express synchronization backend.
- `/auth-relay` - The static return page used by "Continue with Google" (hosted on GitHub Pages).
- `/tests` - The automated tests of all three: run `npm install` and then `npm test` in this folder (details in `ARCHITECTURE.md`, section 5).

## 1. Architecture

GradeScan uses an **Offline-First + Cloud-Synchronized Architecture**.
The mobile app stores all data locally in a robust SQLite database (using `expo-sqlite`). All grading, scanning, matching, and corrections are made against the local database, guaranteeing that work can continue securely even if internet access is lost.

When network connectivity is available, the local `SyncManager` queues background operations to the backend API. 
The backend handles the coordination, conflict detection, and rate-limiting when talking to the final destination (Google Sheets/Excel).

See `ARCHITECTURE.md` for a detailed breakdown.

## 2. Requirements Met

- **Vintage Academic Design:** Meticulously styled using a custom `theme` palette (ivory, parchment, espresso) mimicking classic paper gradebooks. Typography features elegant serifs.
- **Offline Mode First:** `SyncManager`, SQLite schemas, transaction support built-in using real `expo-sqlite` queries.
 - **OCR & Matching:** Full workflows included for offline-compatible multi-student recognition in `ocr.service.ts` and `matching.service.ts`.
 - **Database Architecture:** Complete production SQL schema included in `database/index.ts` alongside helper queries.
 - **Multi-Tenant Ready:** The backend (`backend/src`) uses isolated synchronization strategies and UUID session tracking.
 - **Sign-in & terms gate:** The app can only be entered after the teacher ticks **I agree** to the Terms of Use and Privacy Notice (readable first, English/Arabic, `src/legal/index.ts`, naming Eng Atta as the maker) and signs in with Google, which shares their **name and e-mail** and, on the same Google page, the per-file **Drive** permission for creating attendance sheets in their own Drive (`SignInScreen.tsx`, `TermsScreen.tsx`, `services/auth.service.ts`, `services/terms.ts`). The app has **no "Allow Google Drive" button or link**: the permission is asked only on Google's sign-in page; if the line was unticked, the app says so and the teacher signs out and in again. A small offline guest option remains. Changing `TERMS_VERSION` asks everyone again.
 - **Google Sheets Integration:** One sheet at a time, by link. The teacher pastes the sheet's link; GradeScan reads it and writes the approved grades with **its own Google "robot" account** (a service account, `backend/src/services/google-auth.ts`), so it never gets access to the teacher's Google account or their other sheets, and analysis does not use any Google session. To save grades the teacher shares that sheet with the robot's e-mail as Editor (the app shows the address); a sheet shared as "Anyone with the link can view" can still be read. "Continue with Google" (`backend/src/services/google-oauth.service.ts`, `routes/auth.routes.ts`) identifies the teacher (scopes `openid email profile`) and also asks, in the same trip, for the per-file `drive.file` scope (the teacher may untick it). Setup in `DEPLOY.md`; with the backend on a PC, Google returns through a free static page on GitHub Pages (`auth-relay/callback.html`).
 - **Attendance mode:** a separate, names-only mode (Home → **TAKE ATTENDANCE**, next to the **SCAN GRADES** card). The camera reads only the names on the paper, matches them to the class list, and puts a ✓ for everyone who is present. The teacher either (a) points it at an online Google Sheet shared with the robot as Editor, picks the worksheet and the column for the ticks (an existing column, or a new one titled with today's date), or (b) on the first time, **creates a new Google Sheet inside the teacher's own Google Drive** (with the per-file `drive.file` permission the teacher gave on Google's page at sign-in, so the sheet belongs to the teacher and no permission step interrupts the work; the robot is added as Editor so later days can be ticked) or **keeps the list inside the app** and exports an **Excel (.xlsx)** file. Only empty cells receive a ✓; absent students are left untouched. Code: `mobile/src/screens/Attendance*Screen.tsx`, `services/attendance*.ts`; backend `POST /api/ocr` (`mode=names`), `POST /api/spreadsheet/:id/attendance`, `POST /api/spreadsheet/create-attendance`. Usage and setup (Google Drive API, `npx expo install expo-sharing`) in `DEPLOY.md`.
 - **Localization & RTL:** `i18next` configured for English and Arabic with strict RTL layout flipping support.
 - **Camera Access:** Fully functional `expo-camera` integration for document scanning.

## 3. OCR setup (handwritten Arabic names)

The backend reads sheets with **Google Gemini** when `GEMINI_API_KEY` is set in `backend/.env`, and falls back to the offline Tesseract engine otherwise.

1. Create a free key at https://aistudio.google.com/apikey (no billing needed).
2. Copy `backend/.env.example` to `backend/.env` and set `GEMINI_API_KEY=...`.
3. Rebuild and start: `cd backend && npm run build && npm start` (or `npm run dev`).
4. Check `http://localhost:3000/api/ocr/status` — it should report `"provider": "gemini"`.

**Privacy:** on Google's free tier, uploaded images may be used to improve Google's products and be reviewed by humans. Link a billing account to the key's project for the paid-tier terms (no training on your data; a scan costs a fraction of a cent), or set `OCR_PROVIDER=tesseract` to keep everything offline (much less accurate on handwriting).

## 4. Run from your phone (Expo Go) with Google sign-in

See `DEPLOY.md`: put `auth-relay/callback.html` on GitHub Pages, create the robot Google account and save its key as `backend/service-account.json`, do the one-time Google sign-in setup (name, e-mail and `drive.file`), add the values to `backend/.env`, start the backend on the PC, then open the app in Expo Go (same Wi-Fi), press **TEST** in Settings (it shows the robot's e-mail), and on the sign-in page tick **I agree** and tap **Continue with Google**. For the attendance mode also enable the **Google Drive API** next to the Sheets API and add the `drive.file` scope under Data Access (it is asked together with the sign-in and is only used to create new sheets in the teacher's Drive; the teacher's Gmail must be a Test user, or the app published), and run `npx expo install expo-sharing` in `mobile` (only needed for the Excel export). A cloud host (Render, Docker, …) is optional — Part 6 of `DEPLOY.md`. To let teachers on any network install the app from a link (free Render server + Android APK built with EAS), follow `PUBLISH.md`.
