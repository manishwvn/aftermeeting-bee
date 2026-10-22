# AfterMeeting

AfterMeeting turns one completed Bee conversation into a reviewable next-action handoff. It shows Bee's summary beside exact transcript evidence, lets you edit and choose candidate actions, and downloads a local Markdown note only when you ask.

The app is a small local preparation slice. It does not prove this account's Bee access, Apple Watch capture, source attestation, cross-recording change detection, production readiness, or eligibility for the Bee prize. The official CLI does not attest that a conversation came from Apple Watch; confirm the real capture in the Bee app before any Bee-track demonstration. The only checked-in conversation is marked synthetic and used by tests, never by the product UI.

## Run locally

Use Python 3.11 or newer. This workspace has an ignored, project-local Bee CLI 0.7.3 build for macOS ARM64 at `.local/bee-cli/bin/bee`. Its 21 MB official release archive matched the published SHA-256 `a1eaf68d41454980ded5381a45a3fce1ae2963f46694ac20f4c3ce22bbe34048`; its version/help output and v0.7.3 source contract were checked without account access. The binary is not committed and is specific to this machine.

From this directory, start the app with:

```text
PATH="$PWD/.local/bee-cli/bin:$PATH" python3 app.py
```

Open the printed `http://127.0.0.1:8765` address. If the CLI is not connected to the existing Bee account, run `bee login` yourself in Terminal and complete Bee's own consent flow; do not paste account tokens into this app or chat. After a real Watch recording, wait for Bee to finish processing it, then choose that record and check its timestamp, summary, and source words.

The app can also use the official project-local npm executable at `.local/bee-cli/node_modules/.bin/bee` or an official `bee` executable already on `PATH`. Bee's current docs describe npm installation, but the 0.7.3 native release was chosen here because it is small and checksum-verifiable. Check Bee's official install instructions before setting up another platform.

The backend accepts only same-origin requests on its exact loopback host. It invokes the fixed read-only commands `bee conversations list --limit 10 --json` and `bee conversations get <positive-number-id> --json`; no shell, login command, arbitrary path, token field, write command, or external LLM is exposed. It keeps transcript data in process memory and sends no request logging to disk. The browser uses no persistent storage. A downloaded brief contains the choices and evidence you approved.

## Checks

```text
python3 -B -m unittest discover -s tests -v
node --check app.js
node --test tests/test_frontend.js
```

Tests use only the checked-in fixture, test-owned fake CLI child processes, a fake in-process Bee adapter, and an ephemeral loopback port. They never launch the installed Bee CLI or contact a Bee account.

## Bee data contract reviewed

On October 22, 2026, the official Bee CLI docs and `bee-computer/bee-cli` public source were reviewed. The published list command returns a `conversations` array with `id`, `start_time`, `end_time`, `created_at`, `summary`, and `state`; the CLI's own tests validate that shape. The get command returns a `conversation` with `id`, timestamps, `device_type`, `summary`, `short_summary`, `state`, `transcriptions[].utterances[]`, `suggested_links`, and `primary_location`. Utterance examples include exact `text`, a possibly missing `speaker`, and optional timestamps. The CLI source describes transcript text as automatic speech recognition that can contain errors. The app therefore keeps the Bee utterance as the quote, labels the transcript, and never infers an owner or deadline.

- [Bee CLI reference](https://docs.bee.computer/docs/cli)
- [Official CLI repository](https://github.com/bee-computer/bee-cli)
- [Official v0.7.3 conversation response tests](https://github.com/bee-computer/bee-cli/blob/v0.7.3/sources/resources/conversations/index.test.ts)
- [Official v0.7.3 conversation adapter source](https://github.com/bee-computer/bee-cli/blob/v0.7.3/sources/resources/conversations/index.ts)
- [Official v0.7.3 package manifest](https://github.com/bee-computer/bee-cli/blob/v0.7.3/package.json)

No authenticated CLI call or real-record schema observation has been made in this workspace. The source contract is strict enough to reject unsupported payloads; test fixtures do not replace the pending real-account check.

## Design direction

The first obvious visual route was a generic warm dashboard with rounded summary cards. I dropped it after grounding the screen in its actual job: carrying one promise from spoken words into a reviewable handoff. The final palette uses harbor ink, fog white, sea glass, and a small amber cue. One transcript receipt is the memorable device; the rest is a quiet, left-aligned reading surface with line dividers instead of a grid of identical cards. Avenir carries navigation and controls; Iowan/Palatino/Georgia system serif carries the quote.

```text
Desktop
+------------------------------- AfterMeeting ------------------ local state -+
| Keep the promise in view.                    [single quote receipt]           |
| [Find Bee conversations]                                                      |
+------------------------------- review ---------------------------------------+
| Bee summary and response hash | Candidate action + exact quote + your choice |
|                                | Candidate action + exact quote + your choice |
|                                | [Download reviewed handoff]                  |
+-------------------------------------------------------------------------------+

Mobile
+-------------------------------+
| AfterMeeting                  |
| Keep the promise in view.     |
| [Find Bee conversations]      |
| [single quote receipt]        |
| Bee summary + hash            |
| Candidate, quote, your choice |
| [Download reviewed handoff]   |
+-------------------------------+
```
