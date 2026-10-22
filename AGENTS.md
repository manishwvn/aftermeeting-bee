# AfterMeeting working rules

- Build one local review flow around a single selected Bee conversation.
- Only the official Bee CLI may provide runtime Bee data. Never make fixture data a normal app/demo path or claim Watch provenance from the CLI fields alone.
- Keep the adapter read-only, fixed-command, argument-array based, and local. Do not handle Bee credentials, run a login flow, expose arbitrary command or path inputs, or log transcript contents.
- Preserve Bee identifiers, timestamps, source-response hashes, speaker labels, and exact transcript text. Treat transcript wording as ASR output that may contain errors.
- Candidate actions must cite an exact Bee utterance. Do not infer an owner or deadline. Keep the user in control of review and export.
- Keep Bee records in memory. Write user content only when the user explicitly downloads a brief.
- Tests use fixture-only synthetic records and unique loopback ports. They must never call a real Bee account or write to a shared fixed path.
- Do not add hosted services, external LLM calls, accounts, permissions, paid features, or data-changing Bee commands.
