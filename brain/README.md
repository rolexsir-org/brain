# 🧠 Brain

**Brain is a private, offline-first personal assistant PWA.** It keeps your
personal information in the browser on the device you are using: there is no
Brain account, cloud sync service, analytics, or application server.

Use ordinary language to create and find tasks, reminders, notes, people,
expenses, debts, inventory, habits, journal entries, events, and photos. When
you choose an external action, Brain hands off through a standard device or web
API; it never silently sends messages, publishes social posts, or changes a
third-party account.

> **Important:** Local-only does not mean encrypted. Anyone with access to this
> browser profile or device may be able to access its site data. Keep regular
> backups and use your device’s lock/screen security for sensitive information.

## Contents

- [Run or install Brain](#run-or-install-brain)
- [What Brain stores](#what-brain-stores)
- [Natural-language examples](#natural-language-examples)
- [Device and external actions](#device-and-external-actions)
- [Photos and attachments](#photos-and-attachments)
- [Backup, restore, and data safety](#backup-restore-and-data-safety)
- [Reminders and notification limits](#reminders-and-notification-limits)
- [Offline behavior and privacy](#offline-behavior-and-privacy)
- [Accessibility and mobile use](#accessibility-and-mobile-use)
- [Browser support and honest limitations](#browser-support-and-honest-limitations)
- [Development and verification](#development-and-verification)

## Run or install Brain

Brain is a static ES-module web app. Serve this directory from a web server;
do not open `index.html` directly from the file system.

```bash
cd brain
python3 -m http.server 8000
# Open http://localhost:8000
```

`localhost` is appropriate for development. For a phone, another computer, or
production hosting, use **HTTPS**. Service workers, installation, notifications,
location, clipboard, contact picking, and some sharing features are restricted
to secure contexts by browsers.

After the first successful load, the service worker caches Brain’s app shell,
so its core interface and local data can continue working offline.

### Install as an app

- **Android and desktop Chromium browsers:** Brain shows an install action only
  when the browser provides a real install prompt. Follow the browser prompt.
- **iPhone and iPad:** open Brain in your browser’s Share menu and choose
  **Add to Home Screen**. In Safari, the path is **Share → Add to Home Screen**.
- **Already installed:** the install control stays hidden rather than pretending
  it can install again.

Installation makes Brain easier to launch and can improve how long a browser
keeps it available, but it does **not** turn a web app into a guaranteed
background alarm service. See [Reminders and notification limits](#reminders-and-notification-limits).

## What Brain stores

Everything below is stored locally in the current browser profile.

| Area | What you can do |
| --- | --- |
| **Tasks** | Add one-time tasks, due dates, notes, and daily/weekly/monthly/yearly interval recurrence; complete, reopen, edit, or delete them. Completing a recurring task creates one future occurrence rather than duplicating it. |
| **Reminders** | Create one-time or recurring reminders, snooze them, dismiss/complete them, and export one-time reminders to a calendar file. |
| **Notes** | Keep ordinary or private notes; copy, share, edit, and delete them. “Private” is an in-app label, not encryption. |
| **People** | Store names, aliases, phone numbers, email addresses, locations, birthdays, and Instagram handles. Resolve people by name or alias in commands. |
| **Photos** | Import a supported image, view it, share/save a copy, attach it to a journal entry, or remove it. Camera capture is offered only where the browser exposes a mobile capture picker. |
| **Events** | Save dated events with an optional location and export a standards-compatible `.ics` calendar file. |
| **Money and debts** | Track income, expenses, categories, who owes whom, and settled/open debt status. |
| **Stock** | Add or consume inventory, set low-stock thresholds, adjust quantities, and review retained adjustment history. |
| **Habits and journal** | Log a habit once per day, record journal entries/moods, and keep lightweight health-style entries such as medication, sleep, weight, steps, or blood pressure. |

The menu provides browsable lists and real edit/delete controls for each stored
collection. Natural-language requests such as “show everything about John” run
a local cross-record search. The visible chat conversation is a current-session
interface, not an encrypted or cross-device conversation archive.

## Natural-language examples

Start with your name, then type or use voice input where available.

```text
remind me to take medicine tomorrow at 8pm
remind me to water the plants every Sunday at 9am
add task file taxes on March 12, 2027 at 3pm
submit the assignment by Friday
remember: Wi-Fi password is Home1234
Priya's birthday is March 12
John's number is +91 98765 43210
John lives at 12 Market Road
spent 350 on groceries
salary came in 45000
Ravi owes me 500
add 5 kg of rice
used 3 eggs
did yoga today
I felt great today
schedule dentist appointment tomorrow at 3pm
```

Ask questions and use action-oriented requests too:

```text
what's coming up this week?
show my reminders
show me all birthdays this month
how much did I spend this month?
who owes me?
how much sugar do we have?
what did I do yesterday?
show everything about John
call John
text John "I'll be there at 7"
email John the project update
navigate to John's house
open John's Instagram
share today's plan
```

Brain parses common relative dates, weekdays, explicit calendar dates, clock
times, and recurring schedules. It asks a short follow-up when information is
missing—for example, a reminder date without a time. You can retry that answer
or say **cancel**/**skip**; an invalid answer does not silently create a
reminder or event.

Natural-language understanding is intentionally local and rule-based. Phrase a
request more directly if Brain asks for clarification; it does not send your
text to an AI service.

## Device and external actions

The same capability-aware action system is used by cards, menu shortcuts,
notifications, and natural-language commands. A control is shown only when the
record and current browser make it meaningful. Every external handoff requires
your tap.

| Action | What Brain actually does | What it does **not** do |
| --- | --- | --- |
| **Call** | Opens a `tel:` link for a valid phone number. | It cannot place or confirm a call. |
| **Text** | Opens the system SMS composer using an `sms:` link; text can be prefilled. | It cannot send the SMS. |
| **Email** | Opens the configured mail client with a `mailto:` recipient, subject, and body. | It cannot send email or verify delivery. |
| **WhatsApp** | Opens an official `wa.me` conversation link when a usable international number is known, or WhatsApp’s official share route when only text is available. | It cannot pick a recipient automatically, attach/send a message itself, or read WhatsApp. |
| **Maps and directions** | Opens a Maps search/directions handoff for a saved address, supplied place, or approved current coordinates. | It does not track location in the background. |
| **Current location** | Requests foreground browser location permission only after you tap the action, then opens the location in Maps. | It does not continuously collect or retain location. |
| **Instagram** | Opens a saved public profile URL. “Share to Instagram” uses the system share sheet when the device offers it. | It cannot log in, upload, post, publish, schedule, or automate Instagram. |
| **Share / copy** | Uses the native Web Share sheet when available. Otherwise it uses a real clipboard fallback for text, and a save/download fallback for files. | It does not claim a target app received shared data. |
| **Calendar** | Builds and saves/downloads an RFC 5545 `.ics` event file for the user to open/import in a calendar app. | Browsers cannot silently add an event to a calendar. |
| **Contacts import** | Uses the read-only Web Contacts Picker where exposed and only after your tap; selected contact data is copied into Brain. | It cannot write to your system address book or import without permission. |

### Phone numbers and WhatsApp

For direct WhatsApp chats, save an international number (for example,
`+919876543210`) or set the country calling code in **Settings** for local
numbers. Brain deliberately does not guess a country code, remove a trunk
prefix, or send a message on your behalf.

### Calendar export

Use the **Calendar** action on an event, a due task, or an eligible reminder.
The resulting `.ics` file has local/floating event times because Brain does not
invent a timezone. Choose the calendar app yourself and review the import.

### Voice input

The microphone button is shown only if the browser exposes Web Speech
recognition. Recognition may be absent, may require a network connection, and
may use the browser/vendor’s speech service; this is separate from Brain’s
local storage and command processing. Typed input always remains available.

## Photos and attachments

Photos are kept locally as image data in Brain’s storage and are included in a
backup. The image workflow is deliberately bounded to protect browser storage:

- Choose a supported raster image with the file picker, or use the camera
  capture picker only where it is genuinely available.
- Cancelled pickers do not create a photo record.
- Brain rejects unsuitable files and oversized originals (over 12 MB).
- Imported images are decoded and stored as a bounded JPEG data-URL copy
  (4.75 million characters maximum) when the browser can process them.
- You can preview, save a copy, share through a real system chooser/fallback,
  attach a photo to a journal entry, or delete it.
- Invalid image data and dangling journal-photo references are removed during
  restore validation rather than rendered unsafely.

Photo decoding and camera format support ultimately depend on the browser. If
the device cannot decode a chosen image safely, Brain reports the failure and
does not save a broken placeholder.

## Backup, restore, and data safety

Open **Settings** to back up or restore Brain.

- **Back up:** creates a JSON snapshot and asks the browser to save it. Keep the
  file somewhere you control; it can contain all of your stored personal data,
  including photo data.
- **Restore:** select a Brain JSON backup (maximum 25 MB). Brain previews
  validated contents before changing current data.
- **Merge:** keeps existing records and adds non-duplicate validated records.
  It recognizes matching IDs and equivalent content where possible.
- **Replace all:** after confirmation, replaces current local data with only
  validated backup records.
- **Validation:** malformed records, unsafe/invalid photo payloads, duplicate
  IDs, and invalid attachment references are skipped or repaired. If a restore
  cannot be completed, the app reports the failure and keeps current data.
- **Erase all local data:** requires confirmation. It cannot be undone except by
  restoring a backup.

Browser storage can be cleared by browser settings, private/incognito-session
rules, device cleanup, profile deletion, or storage pressure. Export backups
regularly—especially before clearing browser/site data, changing phones, or
using a browser’s “clear data” feature.

## Reminders and notification limits

Brain schedules and checks reminders while its page/app is able to run. It
checks again when the app becomes visible, after reload, and through its
service-worker notification routing when the browser can deliver it.

- Enable notifications only when the browser presents its permission prompt.
- One-time reminders become visibly fired until you complete or snooze them.
- Recurring reminders use an anchored schedule; a reminder created after
  today’s scheduled time waits for its next valid occurrence rather than
  immediately firing an old occurrence.
- Snoozes and fired state are persisted locally to reduce duplicate catch-up
  alerts after reloads.
- Notification taps/actions route back into an active Brain client where
  possible, or open Brain with the relevant reminder context.

**No browser can guarantee an alarm once the operating system has fully
suspended or closed the web app.** Brain has no push server and makes no claim
of guaranteed closed-app/background reminders. Install Brain for convenient
access, keep browser notification permission enabled, and use a native alarm
app for safety-critical reminders.

## Offline behavior and privacy

### Offline-first core

Tasks, reminders, notes, people, money, debts, stock (including its adjustment
history), habits, journal, events, photos, local search, backup/restore, and
local command processing work from local data. The app shell is cached after a
successful initial visit.

### Things that need another app or network

Calls, messages, email, WhatsApp, Maps, Instagram, calendar import, and a
browser-provided speech service are external handoffs. Their target app,
network connection, account state, and device configuration determine whether
they finish successfully. Brain accurately says it is **opening** or **sharing**
an action rather than claiming it completed it.

### Privacy boundaries

- Brain does not send stored data to a Brain backend because there is no Brain
  backend.
- Your data may leave the device only when you explicitly choose an external
  action or manually move a backup file.
- The destination app/site’s privacy policy applies after a handoff (for
  example, WhatsApp, your mail client, Google Maps, or Instagram).
- Site data is local to a browser profile; it is not automatically synced
  between devices by Brain.

## Accessibility and mobile use

Brain is designed for touch and keyboard use:

- Buttons are semantic controls with labels; unavailable capability-only
  controls are not presented as fake buttons.
- Sheets behave as modal dialogs: focus moves into the sheet, Tab/Shift+Tab is
  contained, Escape/backdrop closes it, and page content is hidden from
  assistive technology while open.
- Menu state communicates its expanded/collapsed state.
- Settings include a **Reduce motion** option.
- Layout/action bars wrap for narrow screens, and the input area is sized for
  mobile keyboards and safe-area insets.

Use the in-app **Device capabilities** screen to see exactly which APIs the
current runtime exposes (notifications, share, files, camera picker, voice,
location, contacts, clipboard, and service worker). The screen reports support,
not a promise that a third-party app will accept a handoff.

## Browser support and honest limitations

Brain targets current evergreen browsers, with best results in current Chrome
on Android/desktop and Safari on iOS/iPadOS. Browser support varies by feature:

| Platform | Expected core experience | Notable browser-dependent limits |
| --- | --- | --- |
| **Android Chrome / installed PWA** | Offline local data, install prompt when eligible, file/photo picker, external handoffs, and many Web Share/notification features. | Android/OS battery policies can suspend apps; notification timing is not an alarm guarantee. Contact picker, camera capture, file sharing, and speech vary by version/device. |
| **iOS Safari / Add to Home Screen** | Offline local data, Share-menu installation guidance, file/photo picker, standard links, and supported sharing. | iOS may suspend installed web apps; closed-app alarms are not guaranteed. Some web APIs (contacts picker, camera capture behavior, file sharing, speech, service-worker notifications) vary by iOS release. |
| **Desktop browser** | Core local data, backup/download, keyboard access, links, and normal file picker. | No camera capture button is advertised merely because a desktop input exposes `capture`; phone/SMS handlers and native share depend on installed apps/browser support. |

If a browser does not expose a capability, Brain hides or degrades that action
rather than showing a decorative control. For example, text sharing can fall
back to copy, and a photo can fall back to saving a copy.

## Development and verification

This repository has no compile step or production backend. It verifies the
static application shell and runs unit plus DOM smoke tests.

```bash
npm install
npm test
npm run build
```

- `npm test` runs domain, persistence, intent/date, capability, external-action,
  notification/service-worker, and UI smoke coverage.
- `npm run build` verifies that the production app shell contains the required
  static assets.

Before releasing a hosted build, manually check the deployed HTTPS version on:

1. Android Chrome both in-browser and installed;
2. iOS Safari and an Add-to-Home-Screen install; and
3. a desktop browser with keyboard-only navigation.

Test actual permission prompts, cancel paths, offline reload, backup/restore,
notification behavior, safe-area/keyboard layout, and each external handoff on
the device(s) you intend to support. Browser and OS policies can change outside
this repository’s control.

## License / use

This project is a local personal-data tool. Review your organization’s policy
before storing sensitive health, financial, or contact data in any browser.
