# 🧠 Brain — your offline personal assistant

A **private, offline** personal assistant that runs entirely on your
device. No server, no cloud, no account, no telemetry. All data stays
in your browser (IndexedDB, with a localStorage fallback).

## How to use it

Brain is an installable PWA split into ES modules. Serve this folder over
HTTP (it needs a static server so modules load and the service worker can
register) — e.g. from this directory:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Once you open it, everything is cached by the service worker, so it works
**fully offline** afterwards. To make it feel like a phone app, tap the
install prompt (Android/desktop Chrome) or on iOS use **Share →
Add to Home Screen**. You can copy the whole folder to another device and
serve it there too.

## What it does (all natural language)

Open the app, type your name, then just talk to it:

```
remind me to take medicine at 8pm
remind me to water plants every sunday at 9am
submit the assignment by friday
remember: wifi password is home1234
Priya's birthday is March 12
add contact: John, 9876543210
spent 350 on groceries
salary came in 45000
Ravi owes me 500
add 5 kg of rice
used 3 eggs
took paracetamol at 2pm
did yoga today
feeling great today
```

...and ask it things:

```
what's coming up this week?
show my reminders
show me all birthdays this month
how much did I spend?
who owes me?
how much sugar do we have?
what did I do yesterday?
what's 15% of 8400?
```

There's also:
- ☰ **Menu** — browse each collection (Tasks, Reminders, Notes, People,
  Money, Debts, Stock, Habits, Journal, Events), **✨ Load Sample data**,
  and ⚙️ Settings. Just chat to add things — no forms needed.
- ⚙️ **Settings** — change your name, currency and number/locale format;
  **backup / restore / merge** your data as a JSON file; erase everything.
- Automatic **daily brief**, **reminders** and **proactive alerts** (low
  stock, upcoming birthdays, overdue tasks) while the app is open.
- Voice input 🎤 where the browser supports it.

## Notes

- Everything is stored locally (IndexedDB). Deleting your browser's site
  data erases Brain — use **Settings → Back up** to keep a copy, or
  restore/merge from a saved file later.
- Upgrades from the earlier single-file build are migrated in
  automatically on first run.
- Reminders fire while the app is open or running in the background.
  Being offline means there is no push-notification server, so a
  fully-closed app cannot fire them — the UI says so honestly instead of
  pretending otherwise.
- Currency/number format defaults to ₹ Indian format. Change it in Settings.

## Privacy

Brain never sends your data anywhere. Your notes, contacts, money,
health and habits stay on *your* device.
