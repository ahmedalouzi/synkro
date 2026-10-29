# Onboarding — Synkro

Your home base is the Trello board **"Synkro — Source of Truth"**. This file mirrors its ONBOARDING list. If they disagree, the board wins.

## Day 0 — Access
- Join the Trello board; get GitHub access; read READ ME FIRST and Project map.
- Post a hello comment on the Day 0 card. Confirm who your reviewer is.

## Day 1 — Run it
```bash
pnpm install
pnpm dev          # desktop app
pnpm typecheck
pnpm test         # needs Postgres: pnpm test:env:up
```
Stuck for 30 minutes? Say so on the card. Fix any unclear step in this doc.

## Day 2 — Understand it
Read `CLAUDE.md` and `docs/ARCHITECTURE.md`. Trace one chat message from `ChatPane.tsx` to `agent-service.ts` to the server gateway. Write a 10-line summary on the card.

## Day 3 — First PR
Take a `starter` card from BACKLOG (README rewrite, repo-root cleanup). Work with your AI agent, review the diff, open a PR, request your reviewer.

## Day 4–5 — Tests & track
Write 2 Given/When/Then test cases (copy the TEMPLATE card). Log failures as backlog cards. Pick a track: Agent/AI · Desktop · Cloud Build · Backend/Infra · QA.

## Ground rules
- One owner per card, someone else reviews. Max 2 cards in DOING per person.
- Daily update by 10:00 on your card: Yesterday / Today / Stuck on.
- Never paste tokens, keys or passwords anywhere. Write `***`.
- Show the diff before pushing; no direct pushes to `main`.

---

# 🇪🇬 الأونبوردنج بالمصري

اللوحة الرئيسية هي بورد Trello اسمها **"Synkro — Source of Truth"**. الملف ده نسخة من ليستة ONBOARDING، ولو في اختلاف البورد هي الأصل.

- **اليوم 0:** ادخل البورد واطلب صلاحية GitHub، واقرا READ ME FIRST وخريطة المشروع، واكتب كومنت "أهلاً" وحدد مين المراجع بتاعك.
- **اليوم 1:** شغّل `pnpm install` و`pnpm dev` و`pnpm typecheck` و`pnpm test` (التست محتاج Postgres: `pnpm test:env:up`). لو وقفت 30 دقيقة قول على الكارت.
- **اليوم 2:** اقرا `CLAUDE.md` و`docs/ARCHITECTURE.md` واتتبع رسالة شات واحدة من الواجهة للسيرفر، واكتب ملخص 10 سطور.
- **اليوم 3:** خد كارت `starter` وافتح أول PR، وراجع الـ diff قبل الـ push.
- **اليوم 4–5:** اكتب حالتين تست Given/When/Then، وأي فشل اعمله كارت، واختار مسارك.

**قواعد أساسية:** كل كارت ليه صاحب واحد ومراجع تاني · أقصى كارتين في DOING · تحديث يومي قبل 10:00 · ممنوع تحط أي توكن أو باسورد (اكتب `***`) · اعرض الـ diff قبل الـ push ومفيش push مباشر على main.
