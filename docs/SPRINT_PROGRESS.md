# Peep — Sprint Progress Log

> Konuşma geçmişinden oluşturulan sprint özeti.  
> Son güncelleme: 2026-06-18

---

## ✅ Sprint 1 — Monorepo & Temel İskelet (Hafta 1–2)

**Kurulanlar:**

- Monorepo yapısı: `apps/desktop` (Electron + React + TypeScript), `packages/shared`, `packages/platform-core`, `packages/agent`, `packages/flutter-adapter`
- 4 panelli layout: Explorer | Editor + Preview | AI Chat | Bottom Output
- Proje açma (Open Project dialog)
- Dosya ağacı ve dosya okuma/yazma
- Tab'lı basit kod editörü (textarea)
- Telefon çerçeveli preview placeholder
- AI chat paneli (stub yanıtlar)
- JSON tabanlı local store (recent projects + settings)
- IPC bridge (`window.peep`)

```
peep/
├── apps/desktop/          # Electron app
├── packages/
│   ├── shared/
│   ├── platform-core/
│   ├── agent/
│   └── flutter-adapter/
├── docs/PRODUCT_PLAN.md
└── README.md
```

**Çalıştırma:**
```bash
cd c:\Users\Administrator\Desktop\peep
pnpm install
pnpm dev
```

---

## ✅ Sprint 2 — Monaco + Flutter Preview + Diagnostics (Hafta 3–12)

**Eklenenler:**

### Monaco Editor
- Dart, YAML, JSON ve diğer dosyalar için syntax highlighting
- Minimap, word wrap, bracket colorization
- `Ctrl+S` ile kaydet
- `Ctrl+P` dosya arama — proje içinde dosya adına göre hızlı arama, Enter ile aç, ok tuşları ile gezin

### Flutter Web Preview
- Proje açılınca otomatik `pub get` + `flutter run -d web-server` (port 5174)
- Telefon çerçevesi içinde iframe preview
- Start / Refresh butonları
- Hata durumunda mesaj gösterimi

### Diagnostics
- `flutter analyze` sonuçları Problems panelinde
- Hataya tıklayınca dosyayı editörde açar
- Kayıt sonrası otomatik yeniden analiz

### File Watcher
- Dosya değişince `analyze` + preview hot reload (`r` stdin)

**Kullanım akışı:**
1. Open Project → Flutter projesi seç
2. Sol panelden veya `Ctrl+P` ile dosya aç
3. Ortada preview otomatik başlar (ilk seferde 30–60 sn sürebilir)
4. Kodu düzenle → `Ctrl+S` → preview güncellenir
5. Altta Problems sekmesinde hataları gör

---

## ✅ Sprint 3 — AI Chat + BYOK + AI Editing (Hafta 13–16)

**Eklenenler:**

### AI Agent (gerçek — OpenAI tool-based)
- Tool-based agent döngüsü (OpenAI)
- Araçlar: `read_file`, `list_dir`, `search_files`, `search_content`, `propose_file_edit`
- Proje bağlamı: tree, pubspec, main.dart, açık dosya, diagnostics

### Settings (BYOK)
- Chat panelinde ⚙ → API key, model, Flutter SDK yolu
- API key yerelde saklanır, UI'da gösterilmez

### Diff + Onay Akışı
- Agent dosya değişikliği önerir → unified diff görünür
- Apply / Reject (tek dosya veya tümü)
- Onay sonrası: dosya yazılır → analyze → preview yenilenir

**Kullanım:**
```
pnpm dev
→ Flutter projesi aç
→ ⚙ Settings → OpenAI API key ekle
→ Chat: "Add a login screen with email and password fields"
→ Diff'i incele → Apply
→ Preview'da sonucu gör
```

---

## ✅ Sprint 4 — Terminal + Git UI (Hafta 19–20)

**Eklenenler:**

### Terminal (xterm.js)
- Alt panelde Terminal sekmesi
- Proje klasöründe PowerShell (Windows) / bash (macOS/Linux)
- Oturum sekme değişince korunur (panel her zaman mount edilip gizlenir)
- `flutter`, `dart`, `git` vb. komutlar çalıştırılabilir

### Git UI
- Alt panelde Git sekmesi
- Branch görüntüleme
- Staged / Changes listesi
- `+` ile stage, `−` ile unstage
- Commit mesajı + Commit butonu
- Dosya seçince sağda diff görünümü
- Repo yoksa "Initialize Git"

### Güvenli Komut Çalıştırıcı
- `runCommand` IPC: sadece allowlist'teki komutlar (`flutter`, `dart`, `git status`, vb.)
- Agent ve otomasyon için kullanıma hazır

---

## ✅ Sprint 5 — Project from Prompt + Templates (Hafta 21–22)

**Eklenenler:**

### 3 Flutter Şablonu

| Şablon | Açıklama |
|--------|----------|
| Blank | Sadece `flutter create` |
| Material App | Material 3 + hoş geldin ekranı |
| Bottom Navigation | 3 sekmeli bottom nav |

### New Project Sihirbazı
TitleBar'da **New Project** butonu → iki mod:

**From Template:**
- Proje adı + parent klasör
- Şablon seç → `flutter create` + şablon dosyaları uygulanır

**From Prompt (AI):**
- Örn: *"Todo app with dark mode and categories"*
- Blank proje oluşturulur → AI otomatik scaffold eder (onay gerekmez)
- API key Settings'te olmalı

**Akış:**
```
New Project → Browse (klasör) → Create
  → flutter create + template overlay
  → (prompt modunda) AI dosyaları yazar
  → proje açılır + preview başlar
```

---

## ✅ Sprint 6 — Beta Hardening (Hafta 23–24)

**Eklenenler:**

### Onboarding Wizard Entegrasyonu
- `App.tsx`: İlk açılışta `getSettings()` ile `onboardingCompleted` kontrolü
- `onboardingCompleted === false` → `OnboardingWizard` tam ekran gösterilir
- Wizard tamamlanınca ana uygulama render edilir, bir daha gösterilmez
- Adımlar: Welcome → Flutter SDK Detection → Telemetry Opt-in → Done

### Empty States
- `EmptyState.css` oluşturuldu (import ediliyordu ama yoktu)
- `EditorPane`: `NoProjectEmptyState` + `NoFileOpenEmptyState` kullanıyor
- `Sidebar`: `NoProjectEmptyState` ile "New Project" ve "Open Folder" butonları
- `ChatPane`: API key yapılandırılmamışsa `NoApiKeyEmptyState` gösteriyor

### Bileşen İletişimi
- `peep:new-project` custom event → herhangi bir child'dan NewProjectModal açılabilir
- `peep:settings-closed` custom event → Settings kapanınca ChatPane API key durumunu yeniden kontrol eder
- `SettingsModal`: X, Cancel ve Save butonlarında event dispatch ediyor

### Auto-Update (önceden mevcut, doğrulandı)
- `auto-update-service.ts`: `electron-updater` ile tam entegre
- Dev modda skip, packaged modda 5 sn sonra kontrol
- IPC: `update:check`, `update:install`, `update:getStatus`

### Telemetry Opt-in (önceden mevcut, doğrulandı)
- `telemetry-service.ts`: Local-only, privacy-first
- Onboarding wizard'da opt-in/opt-out seçimi

---

## 🔄 Sıradaki — Kalan Görevler

- [ ] `electron-builder.yml` — build + dağıtım konfigürasyonu
- [ ] Code signing (macOS notarization, Windows Authenticode cert)
- [ ] Eval seti — 20 agent task senaryosu (screen, fix error, add package)
- [ ] Root-level `templates/` klasörü veya dokümantasyonu

---

## Genel Roadmap Durumu

| Hafta | Konu | Durum |
|-------|------|-------|
| 1–2 | Bootstrap + iskelet | ✅ |
| 3–12 | Editor, Flutter preview, diagnostics | ✅ |
| 13–14 | AI chat, BYOK, read-only tools | ✅ |
| 15–16 | AI editing, diff, accept/reject | ✅ |
| 17–18 | Agent quality (eval, rate limit) | ⏳ kısmen |
| 19–20 | Terminal + Git | ✅ |
| 21–22 | Templates + prompt scaffold | ✅ |
| 23–24 | Beta hardening (onboarding, auto-update, telemetry) | 🔄 sırada |
| **25–26** | **React Native adapter** | ✅ |
| **27–28** | **RN Preview + device frames** | ✅ |
| **29–30** | **Eval set + quality polish** | ✅ |

---

## ✅ Month 10 — Closed Beta Launch

**Eklenenler:**
- **Landing Page (`website/`, removed Oct 30, 2026; the site is now the synkro-web repo):** React Native ve Flutter özelliklerini, 3 ana workflow'u ve pricing tablosunu içeren `index.html`, `style.css`, `main.js`.
- **Beta Feedback Form:** Her hafta kullanıcılara gönderilecek NPS, CSAT ve açık uçlu sorular içeren form.
- **Beta Guide (`docs/BETA_GUIDE.md`):** Tester'ların kurulum yapması ve araçları nasıl kullanması gerektiğini açıklayan kapsamlı döküman.

---

## MVP Tanımı (Tamamlandı mı?)

> *"Install → create project → ask agent to add screen → approve diff → see preview"*

**✅ Tamamlandı ve kapalı beta için dağıtıma hazır!**
