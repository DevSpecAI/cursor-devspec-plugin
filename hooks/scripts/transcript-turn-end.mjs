/**
 * Notice the end of a Cursor turn from the conversation's transcript, for when Cursor
 * does not run the plugin's end-of-turn (`stop`) hook (item cdf020cc).
 *
 * Maintainer notes: why this exists, how a turn end is recognised, and when it can go.
 *
 * ## Why
 *
 * Cursor's command-line agent runs a plugin's own `stop` hook only when the person also
 * has a hooks file of their own that declares `stop` (`~/.cursor/hooks.json`, or the
 * project's `.cursor/hooks.json`), and never in a headless (`-p`) run. Measured with
 * the real plugin on CLI 2026.10.22, 2026.11.05 and 2026.11.19 (task 659a015f). Cursor's
 * documentation says plugin hooks run like any other; Cursor's staff have confirmed the
 * gap as a known bug they are tracking, with no date:
 *
 *  - https://forum.cursor.com/t/cursor-cli-does-not-run-enterprise-or-team-beforesubmitprompt-hooks/173219
 *  - https://forum.cursor.com/t/cursor-cli-2026-11-05-macos-user-level-cursor-hooks-json-is-never-loaded-project-level-cursor-hooks-json-works/177989
 *  - https://forum.cursor.com/t/cursor-cli-omits-beforesubmitprompt-afteragentresponse-and-stop-hooks-loses-token-usage-and-emits-inconsistent-generation-id-values/169059
 *
 * The stop hook is what told DevSpec a turn had ended (mirror-turn.mjs `stop`). Without
 * it the room showed Working until the poller's one-hour backstop, and a turn that
 * errored or was stopped was never reported. Cursor's only workaround is an entry in
 * the person's own hooks file, and the plugin never changes the person's Cursor
 * settings. So the poller, already running while connected, notices the turn's end in
 * the transcript and reports it the way the stop hook would: it tells the room about an
 * error or a stop in Cursor's own words (turn-failure.mjs), names the room commands the
 * turn finished (turn-commands.mjs), clears Working and closes the requests the turn
 * finished (requests.mjs).
 *
 * Remove this, the poller's use of it and the claim in mirror-turn.mjs `stop`, once
 * Cursor runs a plugin's `stop` hook with no hooks file of the person's own, in the
 * terminal and headless: the stop hook then reports every turn end itself. The typed
 * prompt mirror and recall on typed prompts also wait on that fix (the same gate keeps
 * Cursor from running `beforeSubmitPrompt`); nothing here stands in for them.
 *
 * ## What Cursor writes
 *
 * The transcript is `~/.cursor/projects/<project>/agent-transcripts/<conversation>/
 * <conversation>.jsonl`: one JSON row per line, `{"role":"user"|"assistant","message":…}`.
 * When a turn ends Cursor writes `{"type":"turn_ended","status":"success"|"error"|
 * "aborted"}` (with `"error":"…"`) as the final line, and when the next turn starts it
 * rewrites the whole file in place (truncating it first) without that line, then adds
 * the new turn's rows. In an interactive turn that succeeds, Cursor runs the stop hook
 * *before* it writes the line; for an error or a stop, after it. Read from the CLI
 * 2026.11.05 and 2026.11.19 bundles. The transcript is not an official Cursor interface.
 *
 * What a turn looks like, measured on 2026-11-20 (CLI 2026.11.19 live, every write
 * logged; and the 63 real transcripts on the measuring machine, CLI 2026.09.18 to
 * 2026.11.05):
 *  - A turn started by a prompt typed at the terminal starts with a user row
 *    `<timestamp>Friday, Nov 20, 2026, 8:58 PM (UTC)</timestamp>\n<user_query>\n<the
 *    prompt>\n</user_query>`.
 *  - A turn started by a background command's output, which is how a room command's
 *    wake reaches the agent, starts with a user row of Cursor's own fixed wording
 *    (COMMAND_TURN_SENTENCES): `<timestamp>…</timestamp>\n\n<user_query>Briefly inform
 *    the user about the task result and perform any follow-up actions (if
 *    needed).</user_query>`. CLI 2026.11.19 writes that sentence; transcripts from
 *    1 November (25 such rows) add "If there's no follow-ups needed, don't explicitly say
 *    that.". The sentence is not in the CLI, so it is Cursor's server's, and it has
 *    changed once already. **It carries no id**: the background command's output, where
 *    the plugin's wake line is, arrives inside a `<system_notification>` /
 *    `<task_notification>` block that Cursor's transcript writer deletes before it
 *    writes the row (CLI 2026.11.05 bundle; four rows are a bare timestamp). The plugin
 *    cannot put an id there without printing markup that breaks out of Cursor's block,
 *    which it never does.
 *  - The time in those rows is to the minute, so two such turns in the same minute write
 *    byte-identical rows (seen).
 *  - Cursor's server adds user rows inside a turn when it resumes one
 *    (RESUMED_TURN_SENTENCE: "Your previous response was interrupted. Continue from where
 *    you left off.", 10 seen).
 *  - A turn that fails or is stopped at its very start writes `turn_ended` and no user
 *    row: four transcripts are that one line ("Model unavailable on Free…" twice, "User
 *    aborted/interrupted manually." twice).
 *  - The `turn_ended` line carries no id and no time.
 *  - A turn stopped with Ctrl+C has its `turn_ended` written twice, identical, 3 ms
 *    apart.
 *  - When Cursor summarises the conversation (`/summarize`; and on its own as the context
 *    fills) the file keeps every row it had, byte for byte, and gains one user row of
 *    Cursor's own: its tool catalog (`<available_subagent_types>…</dynamic_tool_catalog>`,
 *    no timestamp, no prompt). Measured on CLI 2026.11.19 with `/summarize` (copies in
 *    fixtures/cursor-summarize-2026.11.19); the bundle's writer replays the summarised
 *    messages from Cursor's summary archive ahead of the rest, leaving out any it cannot
 *    load. No summary is in the 63 real transcripts, so one inside a turn is not
 *    measured.
 *
 * ## Which turn a turn end belongs to
 *
 * Nothing Cursor writes names the room command a turn served, so a turn end is taken
 * for the tracked command's only on what the file shows beyond doubt, and otherwise the
 * room is told without answering anything. When the poller hands a room command over it
 * starts tracking a turn (the turn marker) and notes the transcript as it stands
 * (`recordTurnBaseline`): whether Cursor was between turns (the final line a
 * `turn_ended`, or no transcript yet), the bytes before that final line (the rows
 * Cursor keeps when the next turn starts), its length and its modification time.
 *
 * A final `turn_ended` line seen later counts at all only when it was written after
 * tracking started: the file has changed since, and was last written after the marker
 * (so a transcript restored with its old modification time never counts). It is then
 * **the tracked command's turn end** only when all three hold:
 *  - (a) Cursor was between turns when tracking started;
 *  - (b) its position: the rows noted at handover are still the file's first bytes,
 *    unchanged, and the turn end sits after rows written since. A summary keeps them
 *    (above), so it passes; a file that shrank or changed (a restore, summarised rows
 *    Cursor could not load) fails;
 *  - (c) the rows written since start with exactly one turn, and that turn's start row is
 *    the room-command sentence (COMMAND_TURN_SENTENCES, in exactly the form above); bare
 *    timestamp rows and Cursor's resume rows inside it are allowed, any other user row
 *    (a typed prompt, a second notification, Cursor's summary row) fails it. A summary
 *    inside the command's turn cannot be told from a summary turn run straight after it,
 *    whose end replaced the command's (A4), so a turn holding one stays uncertain.
 * Then, as the stop hook would: a turn that ran names the commands that started it as
 * finished and clears Working; an error or a stop answers the tracked command in
 * Cursor's own words (turn-failure.mjs) and closes its request.
 *
 * Every other turn end that ended in an error or was stopped (tracking started in a
 * turn; a rewritten file; a typed turn; a turn that failed at its start with no user
 * row; a second turn; a summary in the turn; no usable snapshot) is decided by its
 * first row ("Which turn it was", below). A room command's turn with one unanswered
 * command that started it gets the definite reply. Otherwise it gets the notice level:
 * the room is told, in Cursor's words and only what is certain (turn-failure.mjs
 * `turnNoticeMessage`), in a message of its own (`turnFailureNotice`) that answers and
 * closes nothing, and the working attempt is ended without naming a command
 * (turn-commands.mjs `attemptEndArguments`: DevSpec ends the attempt being worked on,
 * never a command still waiting), so Working clears at once. The end then settles, or
 * for a typed turn is only watched ("Settling and watching", below). When the stop hook
 * runs it knows its turn, and adds the report level at once: the command's failure
 * reply and its request closed (the upgrade, below). Every other turn that ran ends as
 * before this existed: Working until the agent's answer, the next command or the
 * backstop.
 *
 * If Cursor changes the sentence, nothing matches (c) and every error goes to the room
 * as a message of its own: the safe direction. Add a new wording to
 * COMMAND_TURN_SENTENCES only once it has been seen in a real transcript, with its CLI
 * version.
 *
 * A turn end's identity, which the stop hook and the poller both claim, is
 * `<conversation>#<number of user rows>#<digest of the last user row>`, and for an
 * error or a stop also `#<digest of the turn_ended line>@<its byte offset>`
 * (`turnEndIdentity`). The stop hook can work it out when it runs: before the line
 * exists for a turn that ran, after it for an error or a stop. A claim made before the
 * tracked turn started does not count against it (`claimTurnEnd` `after`).
 *
 * ## Reported once, at two levels
 *
 * Whichever of the stop hook and the poller reports a turn end claims it first
 * (`claimTurnEnd`, an exclusive file create in the connection's state folder), for one of
 * two levels:
 *  - the report level (the stop hook always; the poller when attributed): the room told
 *    (the command's failure reply, or a notice when the turn answers none), the turn
 *    reported finished by name, its requests closed. Settled "reported".
 *  - the notice level (the poller, when not attributed): the room told in a notice of its
 *    own and the working attempt ended without a name. Settled "noticed".
 * A claim is "reporting" until its level's steps have all reached DevSpec. A step that
 * did not land gives the claim back and keeps the turn's marker, so the other path, or
 * the poller's next try (`nextReportTry`), does what is left; what already landed is
 * recorded on the claim (`noteTurnEndTold`, `noteTurnEndNoticed`, `noteTurnEndCompleted`,
 * `noteTurnEndAttemptEnded`) and never sent twice, at either level. The other path leaves
 * a claim a live process is working on alone, and takes over one given back or one whose
 * owner process has gone.
 *
 * The stop hook knows the turn it ends, so it can always add the report level: it takes
 * a "noticed" claim over (the upgrade) and answers the command and closes its request
 * without a second notice; and when it finds the poller posting a notice right now, it
 * answers and closes alongside, never posting a notice of its own, and leaves the claim
 * and the marker to the poller. The poller never adds the notice level to a turn end the
 * stop hook has reported or is reporting: the stop hook's message told the room.
 *
 * ## Which turn it was, when (a), (b) and (c) do not all hold
 *
 * No id says which room command a turn served, but a turn's first row says what kind of
 * turn it was (firstRowOf): Cursor's room-command sentence (a room command's turn), a
 * prompt typed at the terminal (`<user_query>` on lines of its own), or neither, when
 * no first row is visible (the turn wrote none, A3; Cursor's summary turn; a row this
 * module does not know; no usable snapshot; the file's first rows changed). The turn's
 * first row is the latest row that starts a turn since the snapshot, or, when tracking
 * started inside a turn and none has started since, that turn's.
 *  - Typed: what the reader before this one did for a typed turn. An error or a stop is
 *    told (a notice) and Working cleared; no command is replied to or closed. Commands
 *    waiting to run stay open until their own turn runs and ends, and that turn reports
 *    itself (the watch below).
 *  - Room command: the commands that started the tracked turn (turn-commands.mjs) and
 *    are still unanswered, never one delivered into a turn already running (Cursor
 *    holds its wake). One: the definite reply, as a matched end. Several: a notice, then
 *    the settle point's one reply for all of them. None (its own command answered, or a
 *    turn already running at handover) with others waiting: a notice only, as typed.
 *  - Unknown: a notice, then the settle point's reply for every unanswered command
 *    picked up before the end.
 *
 * ## Settling and watching
 *
 * After a notice the end settles, or for a typed turn is watched (`startSettle`,
 * `settleStep`). Cursor holds a wake that arrives during a turn. Measured on CLI
 * 2026.11.19 (2026-11-20; SETTLE_MS): idle -> wake turn 1.78 s; normal end -> held turn
 * 1.46 s; Ctrl+C -> held indefinitely (nothing in 45 s; in a second run nothing in 25 s,
 * then it ran 1.6 s after the person's next typed turn ended).
 *  - The settle point: once Cursor has been idle at the end for SETTLE_MS, the commands
 *    it may answer get one reply with only what is certain (turn-failure.mjs
 *    `uncertainTurnFailureMessage`): Cursor ended a turn with an error, in its own words,
 *    or was stopped at its terminal, before it answered this, and if Cursor runs it later
 *    its answer will appear here. Their requests close. Errors and stops alike. A watch
 *    has no settle point.
 *  - A turn Cursor starts from a wake (the room-command sentence) after the end, before
 *    or after the settle point, is tracked as any command's turn, from just before it:
 *    Working shows while it runs and clears when it ends, and its end is reported (it is
 *    matched: the first turn since). Before the settle point, that decides the settle.
 *  - A typed turn after the end is waited for; the idle clock starts again at its end.
 *    The same end written again (Ctrl+C writes it twice; a held turn that fails at its
 *    very start writes the same line) also starts the clock again.
 *  - A command handed over while an end settles settles it at once, with the same
 *    reply; a watch just ends.
 *  - The stop hook's definite report supersedes it: the settle then adds nothing.
 *  - An answer the agent posts later, for a command already answered and closed, still
 *    reaches the room. The plugin stamps no closed request on it (requests.mjs
 *    `requestRefForWrite`), and DevSpec binds a connection's post to its last command
 *    once that turn has closed and lands new text as a message of its own (DevSpecV2
 *    59acf1bfe, migration 737; its tests "binds to the previous command and quotes it"
 *    and "lands a late answer instead of dropping it once the turn is already closed"
 *    pass there).
 *
 * ## Every way a turn ends (the case table; the tests carry these codes)
 *
 * Rows are the turn's first row; columns how it ended. Each cell: what the room sees,
 * whether the room commands' requests close, and whether Working clears. "Matched"
 * meets (a), (b) and (c), which needs a room-command first row.
 *  R1 Room-command first row.
 *    finished: matched: its commands reported finished, requests close once answered,
 *      Working clears; otherwise as before this existed (nothing reported).
 *    errored: matched, or one unanswered command started it: the definite reply in
 *      Cursor's words, requests close, Working clears. Several started it: a notice and
 *      Working cleared at once, one reply for all at the settle point, requests close.
 *      Its own answered (or it ran before handover) and others waiting: a notice and
 *      Working cleared; the waiting commands stay open until their own turns report.
 *    stopped: as errored, in a stop's words.
 *  T1 Typed first row.
 *    finished: as before this existed: nothing reported.
 *    errored: a notice in Cursor's words and Working cleared; no reply; commands
 *      waiting stay open until their own turn runs, is tracked (Working shows) and
 *      reports itself.
 *    stopped: as errored, in a stop's words. Measured: after Ctrl+C Cursor holds the
 *      command's turn until the person's next turn has run; it then runs and reports.
 *  U1 Unknown first row (none visible).
 *    finished: as before this existed: nothing reported.
 *    errored: a notice and Working cleared at once; at the settle point one reply with
 *      what is certain for every unanswered command picked up before the end; requests
 *      close. The only cells that use the settle point's reply, besides R1 with several
 *      commands.
 *    stopped: as errored, in a stop's words.
 * Across every row:
 *  - Ctrl+C writes the end twice, 3 ms apart: one identity, reported once; a settle's
 *    idle clock starts again at each write.
 *  - A summary row inside a room command's turn leaves it R1 (unmatched: by its
 *    starting commands); a summary turn of its own is U1.
 *  - The transcript unreadable for a while, then readable unchanged: nothing is decided
 *    on a failed read; once read, as its row (A16).
 *  - Its first rows changed, or no usable snapshot of the turn's start: U1 (A5, T8).
 *  - The stop hook runs (a hooks file of the person's own): it knows its turn and
 *    reports it, once (C1-C12); a settle then adds nothing.
 *  - Two commands picked up: R1 by the ones that started the turn; U1 one reply for all.
 *  - A final line Cursor is not known to write (format not recognised): nothing
 *    reported, as before this existed (A7). The only cell that reports nothing for an
 *    error or a stop.
 *
 * ## Every interleaving, and what happens (the tests carry these codes)
 *
 * "Attributed" is a turn end that meets (a), (b) and (c) above; "a notice" is the notice
 * level: the room told in Cursor's words in a message of its own, answering and closing
 * nothing, and the working attempt ended without naming a command; the end then settles
 * or is watched ("Settling and watching").
 *
 * Tracking starts between turns:
 *  - A1 The command's turn (its start row the room-command sentence) runs and ends:
 *    attributed; its commands reported finished once, Working cleared.
 *  - A2 It ends in an error or is stopped: attributed; the command answered in Cursor's
 *    words and its request closed, once.
 *  - A3 A turn fails at its very start, writing no user row: not attributed (no start
 *    row); an error or a stop is a notice.
 *  - A4 The command's turn end is overwritten by the next turn before any lap: the rows
 *    since hold two turns, so it is not attributed; an error is a notice, a turn that ran
 *    ends as before.
 *  - A5 The first rows change (a restore; summarised rows Cursor could not load):
 *    position unknown, not attributed; an error is a notice.
 *  - A6 A stopped turn's end is written twice as tracking starts: not a new end.
 *  - A7 The final line is not a turn end Cursor is known to write: nothing.
 *  - A8 Two command turns in one minute write identical rows: the second turn is its
 *    own, rows since tracking started, attributed.
 *  - A9 A prompt typed after the command was handed over runs first: its start row is
 *    the person's own text, so not attributed; an error is a notice, never the command's
 *    answer.
 *  - A10 No transcript yet: between turns, every row is new.
 *  - A11 Cursor's error is longer than any fixed read: read and quoted whole.
 *  - A12 An older transcript restored, with its old modification time: never counted.
 *  - A13 Cursor changes the room-command sentence: nothing matches; an error is a
 *    notice, a turn that ran ends as before.
 *  - A14 Cursor summarises the conversation: the position holds (real fixture). A command
 *    handed over after the summary is attributed as any other; a turn holding the summary
 *    row (one inside the command's turn, or one run between handover and it) is not: an
 *    error is a notice, a turn that ran ends as before.
 *  - A15 Cursor starts another turn before the notice's attempt end is sent: the
 *    transcript no longer ends at that turn end, so no attempt is ended; the new turn
 *    owns Working. A read that fails at that point is not taken for a new turn: the
 *    step is tried again (D1).
 *  - A16 A read of the transcript fails (it cannot be opened or read, changes while it
 *    is read, or its final line does not parse), then a later read of the same,
 *    unchanged file succeeds: the failed read marked nothing as checked, so the later
 *    one reports the turn end, once. The same holds for the once-a-second check and
 *    the usage-limit reader (usage-refusal.mjs).
 *  - A17 The snapshot at handover cannot be read: a pending snapshot keeps the file's
 *    size and time, and is taken on a later look while the file still has them (the
 *    same file, so the same snapshot); the turn's end is then reported as any other.
 *    Once the file has changed it is never taken, and that turn ends as before.
 * Tracking starts in a turn:
 *  - B1 The running turn ends, or a later turn does: never attributed; a turn that ran
 *    ends as before.
 *  - B2 Any of them ends in an error or is stopped: by its first row. A typed turn
 *    already running at handover: a notice; the command stays open until its own turn.
 *  - B3 An error dated before tracking started: nothing.
 * The stop hook (only where the person has a hooks file; it knows which request its turn
 * served, so it answers as it always has):
 *  - C1 A turn that runs: the hook runs before the line exists, reports, clears Working;
 *    the poller and its backstop add nothing.
 *  - C2 An error: the hook runs before the poller's lap and reports; the poller adds
 *    nothing.
 *  - C3 The poller reports first; the hook runs after: it adds nothing.
 *  - C4 The hook runs while the poller's post is in flight: it adds nothing.
 *  - C5 The poller's post fails before the hook runs: the hook reports it.
 *  - C6 The hook's own post fails: it gives the claim back and keeps the marker; the
 *    poller reports it from the transcript.
 *  - C7 The hook's completion fails on a turn that ran: the poller completes it once the
 *    line is written.
 *  - C8 An owner process is killed mid-report (a hook past Cursor's timeout, a poller
 *    restarted): the other path takes its claim over.
 *  - C9 The poller's post lands but a later step fails, then the hook runs: the hook
 *    finishes it without telling the room again.
 *  - C10 The poller noticed a turn end it could not attribute (a notice, the attempt
 *    ended), then the hook runs: it takes the noticed claim over and answers the command
 *    and closes its request, once; the notice is not repeated.
 *  - C11 The hook runs while the poller's notice is in flight: it answers the command and
 *    closes its request alongside, posting no notice; the poller's notice lands, or is
 *    tried again (D1): one notice, one answer.
 *  - C12 The hook told the room, then gave its report back, on a turn end the poller
 *    cannot attribute: the poller ends the attempt if the hook did not, without telling
 *    the room again.
 * No stop hook:
 *  - D1 The poller's post fails, with or without a hook running during it: the claim is
 *    given back, the marker kept, and the poller tries again REPORT_RETRY_MS later: told
 *    once.
 *  - D2 Every try fails: after REPORT_ATTEMPTS the poller stops; the turn ends as before.
 *  - D3 A request close fails: retried the same way, without telling the room again.
 *  - D4 The notice lands but ending the attempt fails: retried the same way, without a
 *    second notice.
 *  - D5 A report throws part-way: the claim is given back with what already landed, and
 *    the next try does the rest (reportHoldingClaim). A claim file that exists but
 *    cannot be read is never set aside: its progress is unknown, so the poller tries
 *    again later.
 *
 * ## Failing safe
 *
 * Only a complete final line whose `type` is "turn_ended" and whose status is one of
 * the three above is a turn end, read whole whatever its length (`lastTurnEnd`), and
 * only from a read of the whole transcript that did not change while it was read nor for
 * 25 ms after (Cursor rewrites the file in place, so a read can catch it half written:
 * that read is retried, never used). With no baseline, an unreadable transcript, a line
 * it does not recognise or a sentence it does not know, nothing is attributed; the
 * plugin never answers a command it cannot tie to the turn end beyond doubt.
 *
 * Nothing is recorded as checked on a read that did not complete (requirement 3ea2b201:
 * state advances only for work actually done). The per-lap and once-a-second checks
 * remember a transcript's size and time only after its final line was read and, for the
 * lap, only when there is nothing to report; a turn end handed to the caller is
 * remembered by its report (the claim), which records each step only once it reached
 * DevSpec and settles only when all have. A failed read, a parse error, a snapshot that
 * could not be taken, an unreadable claim, and a throw part-way through a report all
 * leave things where they were, so the next look reads again (A16, A17, D5).
 *
 * ## Known limits
 *
 *  - Any background command's output starts a turn with the same sentence, so a
 *    background job the agent itself started, finishing first, would pass (c). The
 *    request DevSpec has open for the connection is the one answered.
 *  - A turn that ran after tracking started in a turn, or after a rewrite, ends as
 *    before: Working until the agent's answer, the next command or the backstop.
 *  - An unmatched error or stop gets the definite reply only when the stop hook runs
 *    (C10) or the command's own later turn is tracked; otherwise the settle point's
 *    reply says only what is certain. An upgrade whose post is refused is not tried
 *    again; the settle point still answers the command.
 *  - The settle point rests on Cursor starting a held wake on its own within SETTLE_MS
 *    when it does so at all (measured 1.46 s and 1.78 s); a wake held longer (after
 *    Ctrl+C, until the person's next turn) is answered with what is certain first, and
 *    its turn is still tracked and its answer still reaches the room.
 *  - The notice level ends the attempt being worked on, which is the tracked command's
 *    unless a turn started since holds one (A15 keeps that case out): DevSpec closes
 *    that attempt's own command with it, but never answers it.
 *  - A headless (`-p`) run killed by a signal writes no `turn_ended` line, so its end
 *    is not noticed (CLI 2026.11.19). Stopping a turn in the terminal with Ctrl+C does
 *    write one: `{"type":"turn_ended","status":"aborted","error":"User
 *    aborted/interrupted manually."}`.
 *  - A turn end is noticed within about a second while DevSpec's push channel is open
 *    (the poller's local check), otherwise at the poller's next poll.
 *  - The poller does the stop hook's request bookkeeping at a turn's end
 *    (requests.mjs `finishTurnRequests`), but without the host's list of background
 *    work: a request whose launched work has not woken the agent yet stays open until a
 *    later turn end closes it.
 *
 * Imports only Node built-ins and private-state.mjs, so every hook and the poller can
 * load it.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { STATE_ABSENT, STATE_OK, readPrivateJson, readPrivateJsonResult, writePrivateJson } from './private-state.mjs'

const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')

/** The statuses Cursor writes on a `turn_ended` line. Any other is not a turn end. */
const TURN_END_STATUSES = new Set(['success', 'error', 'aborted'])

/**
 * The transcript's final line is read backwards in pieces this size until the newline
 * before it, so a line of any length is read whole and only that line is read: a step,
 * not a limit. Cursor's own transcript writer leaves out any row over 5 MB ("Oversize
 * transcript blob omitted", CLI 2026.11.05), so the final line stays a few megabytes at
 * most.
 */
const LINE_READ_CHUNK_BYTES = 64 * 1024

/** A whole-transcript read goes in pieces this size, so a long transcript is never held at once. */
const READ_CHUNK_BYTES = 1024 * 1024

/**
 * Smaller I/O and scan step used only when a caller supplies a wall-clock `deadlineMs`
 * (e.g. synchronous `preToolUse` typed-turn sync). Each 64 KB step completes in <1 ms so
 * `deadlineMs` is enforced mid-file and mid-row without cutting or limiting row length
 * (requirements 3c5147a7 / 91d7b47c).
 */
const BOUNDED_STEP_BYTES = 64 * 1024

const ROLE_USER_MARKER = Buffer.from('"role":"user"')
const TURN_ENDED_MARKER = Buffer.from('"turn_ended"')
const BUDGET_EXHAUSTED_TOKEN = Symbol('budget_exhausted')

/**
 * A read of the whole transcript counts only when the file has not changed while it was
 * read nor for STABLE_READ_GAP_MS after. Cursor rewrites the file in place at a turn's
 * start (Node's writeFile: truncate, then the content in pieces with a pause between
 * them), so a read can catch a prefix of it; the pieces follow each other far faster
 * than 25 ms, so a file that keeps still that long is whole. A read that does not count
 * is tried again, up to STABLE_READ_ATTEMPTS times, so a hook or a poller lap waits at
 * most about half a second.
 */
export const STABLE_READ_ATTEMPTS = 8
export const STABLE_READ_GAP_MS = 25

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** The conversation a transcript belongs to: its file name, which is the conversation id. */
export function transcriptConversation(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath.endsWith('.jsonl')) return null
  const name = path.basename(transcriptPath, '.jsonl')
  return name || null
}

/**
 * The transcript's turn end, or null when its final line is not one or it could not be
 * read (readLastTurnEnd tells the two apart): Cursor writes `turn_ended` only as the
 * final line and removes it when the next turn starts. The line is read whole whatever
 * its length, so Cursor's error text is never cut here. `key` identifies this line (the
 * file, where the line sits and what it says), `atMs` is the file's modification time
 * and `stamp` its size and modification time as read.
 */
export function lastTurnEnd(transcriptPath) {
  return readLastTurnEnd(transcriptPath).end
}

/**
 * Read the transcript's final line: `{ read: true, end }`, `end` the turn end or null
 * when the final line is not one (or there is no transcript), or `{ read: false, end:
 * null }` when no whole, unchanged final line could be read (the file could not be
 * opened or read, changed while it was read, or its final line does not parse yet). A
 * caller that remembers what it has checked records a file as checked only after a read
 * that says `read: true`: a failed read is read again (see "Failing safe").
 */
export function readLastTurnEnd(transcriptPath) {
  const failed = { read: false, end: null }
  if (typeof transcriptPath !== 'string' || !transcriptPath) return { read: true, end: null }
  let fd
  try {
    fd = fs.openSync(transcriptPath, 'r')
  } catch (error) {
    return error?.code === 'ENOENT' ? { read: true, end: null } : failed
  }
  let text
  let lineStart = 0
  let atMs
  let stamp
  try {
    const { size, mtimeMs } = fs.fstatSync(fd)
    atMs = mtimeMs
    stamp = fileStampOf({ size, mtimeMs })
    const pieces = []
    let position = size
    let ending = true
    while (position > 0) {
      const length = Math.min(LINE_READ_CHUNK_BYTES, position)
      position -= length
      let piece = Buffer.alloc(length)
      fs.readSync(fd, piece, 0, length, position)
      if (ending) {
        // The newline that ends the final line is not part of it.
        let end = piece.length
        while (end > 0 && (piece[end - 1] === 0x0a || piece[end - 1] === 0x0d)) end -= 1
        piece = piece.subarray(0, end)
        if (end === 0) continue
        ending = false
      }
      const newline = piece.lastIndexOf(0x0a)
      if (newline >= 0) {
        pieces.unshift(piece.subarray(newline + 1))
        lineStart = position + newline + 1
        break
      }
      pieces.unshift(piece)
      lineStart = position
    }
    text = Buffer.concat(pieces).toString('utf8').trim()
    // Rewritten while it was read: what was read may be a piece of either version.
    if (fileStampOf(fs.fstatSync(fd)) !== stamp) return failed
  } catch {
    return failed
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      /* nothing to release */
    }
  }
  if (!text) return { read: true, end: null }
  let row = null
  try {
    row = JSON.parse(text)
  } catch {
    return failed // a line still being written
  }
  if (row?.type !== 'turn_ended') return { read: true, end: null }
  return {
    read: true,
    end: {
      key: `${transcriptPath}#${lineStart}#${crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)}`,
      status: typeof row.status === 'string' ? row.status : null,
      error: typeof row.error === 'string' && row.error.trim() ? row.error.trim() : null,
      atMs,
      stamp,
    },
  }
}

/** Whether a turn end from lastTurnEnd is one this module recognises (see the header). */
function recognisedEnd(end) {
  return Boolean(end && TURN_END_STATUSES.has(end.status))
}

/**
 * What the room is told about a turn end, in turn-failure.mjs's terms: an error with
 * Cursor's own text, a stop, or nothing for a turn that ran.
 */
export function turnEndFailure(end) {
  if (end?.status === 'error') return { status: 'error', text: end.error ?? null }
  if (end?.status === 'aborted') return { status: 'aborted', text: null }
  return null
}

/**
 * One whole read of the transcript, or why there is none: `missing`, or null when it
 * changed under the read. An empty file is Cursor's rewrite caught between truncating
 * it and writing it: Cursor never leaves a transcript empty.
 */
function readWholeOnce(transcriptPath, { deadlineMs = null } = {}) {
  if (deadlineMs !== null && Date.now() >= deadlineMs) return { budgetExhausted: true }
  let fd
  try {
    fd = fs.openSync(transcriptPath, 'r')
  } catch (error) {
    return error?.code === 'ENOENT' ? { missing: true } : null
  }
  try {
    const before = fs.fstatSync(fd)
    if (before.size === 0) return null
    const stepBytes = deadlineMs !== null ? BOUNDED_STEP_BYTES : READ_CHUNK_BYTES
    const chunks = []
    let offset = 0
    while (offset < before.size) {
      if (deadlineMs !== null && Date.now() >= deadlineMs) return { budgetExhausted: true }
      const chunk = Buffer.alloc(Math.min(stepBytes, before.size - offset))
      const read = fs.readSync(fd, chunk, 0, chunk.length, offset)
      if (read <= 0) break
      chunks.push(read === chunk.length ? chunk : chunk.subarray(0, read))
      offset += read
    }
    const after = fs.fstatSync(fd)
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return null
    return { chunks, stamp: fileStampOf(before), atMs: before.mtimeMs }
  } catch {
    return null
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      /* nothing to release */
    }
  }
}

/**
 * The start row of a turn Cursor begins for a background command's output, which is how
 * a room command's wake reaches the agent: Cursor's server's own fixed sentence, in a
 * `<user_query>` with no surrounding blank lines after a blank line under the timestamp
 * (a prompt typed at the terminal is laid out `<user_query>\n…\n</user_query>`). Exactly
 * these sentences, as seen in real transcripts (see the header); any other text is not
 * a room command's turn.
 */
export const COMMAND_TURN_SENTENCES = Object.freeze([
  // CLI 2026.11.19, 2026-11-20.
  'Briefly inform the user about the task result and perform any follow-up actions (if needed).',
  // Transcripts written 2026-11-01 (CLI 2026.10.x), 25 rows.
  "Briefly inform the user about the task result and perform any follow-up actions (if needed). If there's no follow-ups needed, don't explicitly say that.",
])

/** The row Cursor's server adds inside a turn it resumes (10 seen); not a turn of its own. */
export const RESUMED_TURN_SENTENCE = 'Your previous response was interrupted. Continue from where you left off.'

const TIMESTAMP = '<timestamp>[^<\\n]*</timestamp>'

/**
 * A prompt typed at the terminal, as Cursor writes it: its timestamp, then the prompt in
 * a `<user_query>` on lines of its own (CLI 2026.11.19 live; 61 such rows in the real
 * transcripts, some after a `<manually_attached_skills>` block, so not anchored at the
 * start). A room command's start row has no line break inside its `<user_query>`.
 */
const TYPED_PROMPT = new RegExp(`${TIMESTAMP}\\n<user_query>\\n[\\s\\S]*\\n</user_query>$`)

/**
 * The row Cursor adds when it summarises the conversation: its tool catalog, no
 * timestamp and no prompt (CLI 2026.11.19 /summarize, fixtures/cursor-summarize-2026.11.19).
 */
const SUMMARY_ROW = /^<available_subagent_types>[\s\S]*<\/dynamic_tool_catalog>$/

/**
 * What a user row's text is: a room command's start row (`command_turn`), a prompt typed
 * at the terminal (`typed`), a bare timestamp, Cursor's resume row, Cursor's summary row,
 * or `other` (none of these: a row this module does not know).
 */
function userRowKind(text) {
  for (const sentence of COMMAND_TURN_SENTENCES) {
    if (text === sentence) continue // a start row always carries its timestamp
    if (text.endsWith(`</user_query>`) && text.includes(sentence)) {
      const form = new RegExp(`^${TIMESTAMP}\\n\\n<user_query>${escapeRegExp(sentence)}</user_query>$`)
      if (form.test(text)) return 'command_turn'
    }
  }
  if (text.startsWith('<timestamp>') && text.endsWith('</timestamp>') && new RegExp(`^${TIMESTAMP}$`).test(text)) return 'timestamp'
  if (text === RESUMED_TURN_SENTENCE) return 'resumed'
  if (text.endsWith('\n</user_query>') && text.includes('<timestamp>') && TYPED_PROMPT.test(text)) return 'typed'
  if (text.startsWith('<available_subagent_types>') && text.endsWith('</dynamic_tool_catalog>') && !text.includes('<user_query>')) return 'summary'
  return 'other'
}

/** A row that can start a turn: a room command's, a typed prompt, or a row not known. */
const startsTurn = (row) => row.kind === 'command_turn' || row.kind === 'typed' || row.kind === 'other'

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The text of a user row, as Cursor writes it: its message's text parts, joined. */
function userRowText(row) {
  const content = row?.message?.content
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('') : ''
}

/**
 * Read the whole transcript, from one read that did not change while it was read.
 * Returns `{ bytes, size, stamp, atMs, turns, lastUser, end, lastLineStart,
 * lastLineDigest, userRows }`: `turns` the number of user rows, `lastUser` a digest of
 * the last one (null with none), `end` the final line when it is a turn end (else null),
 * `lastLineStart` the byte offset of the final line and `lastLineDigest` a digest of it,
 * and `userRows` each user row's byte offset and kind (userRowKind). `{ missing: true }`
 * when there is no transcript yet, or null when no clean read could be had.
 */
export function readTranscriptTurns(transcriptPath, { attempts = STABLE_READ_ATTEMPTS, deadlineMs = null } = {}) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (deadlineMs !== null && Date.now() >= deadlineMs) return { budgetExhausted: true }
    if (attempt > 0) {
      if (deadlineMs !== null && Date.now() + STABLE_READ_GAP_MS > deadlineMs) return { budgetExhausted: true }
      sleepSync(STABLE_READ_GAP_MS)
    }
    const whole = readWholeOnce(transcriptPath, { deadlineMs })
    if (whole?.budgetExhausted) return { budgetExhausted: true }
    if (whole?.missing) return { missing: true }
    if (!whole) continue
    // Still the same file a moment later: not a piece of a rewrite in progress.
    if (deadlineMs !== null && Date.now() + STABLE_READ_GAP_MS > deadlineMs) return { budgetExhausted: true }
    sleepSync(STABLE_READ_GAP_MS)
    if (fileStamp(transcriptPath) !== whole.stamp) continue
    const bytes = concatChunksBounded(whole.chunks, deadlineMs)
    if (bytes === BUDGET_EXHAUSTED_TOKEN) return { budgetExhausted: true }
    const parsed = scanTranscript(bytes, { deadlineMs })
    if (parsed?.budgetExhausted) return { budgetExhausted: true }
    if (parsed) return { ...parsed, bytes, size: bytes.length, stamp: whole.stamp, atMs: whole.atMs }
  }
  return null
}

function concatChunksBounded(chunks, deadlineMs) {
  if (deadlineMs === null) return Buffer.concat(chunks)
  let total = 0
  for (const c of chunks) total += c.length
  const out = Buffer.allocUnsafe(total)
  let offset = 0
  for (const c of chunks) {
    if (Date.now() >= deadlineMs) return BUDGET_EXHAUSTED_TOKEN
    c.copy(out, offset)
    offset += c.length
  }
  return out
}

function findByteBounded(bytes, byte, start, end, deadlineMs) {
  if (deadlineMs === null) {
    const idx = bytes.indexOf(byte, start)
    return idx >= 0 && idx < end ? idx : -1
  }
  for (let pos = start; pos < end; pos += BOUNDED_STEP_BYTES) {
    if (Date.now() >= deadlineMs) return BUDGET_EXHAUSTED_TOKEN
    const limit = Math.min(pos + BOUNDED_STEP_BYTES, end)
    const idx = bytes.subarray(pos, limit).indexOf(byte)
    if (idx >= 0) return pos + idx
  }
  return -1
}

function trimSliceBounds(bytes, start, end, deadlineMs = null) {
  let s = start
  let e = end
  if (deadlineMs === null) {
    while (s < e && (bytes[s] === 0x20 || bytes[s] === 0x09 || bytes[s] === 0x0d || bytes[s] === 0x0a)) s += 1
    while (e > s && (bytes[e - 1] === 0x20 || bytes[e - 1] === 0x09 || bytes[e - 1] === 0x0d || bytes[e - 1] === 0x0a)) e -= 1
    return { s, e }
  }
  let nextCheck = s + BOUNDED_STEP_BYTES
  while (s < e && (bytes[s] === 0x20 || bytes[s] === 0x09 || bytes[s] === 0x0d || bytes[s] === 0x0a)) {
    s += 1
    if (s >= nextCheck) {
      if (Date.now() >= deadlineMs) return BUDGET_EXHAUSTED_TOKEN
      nextCheck = s + BOUNDED_STEP_BYTES
    }
  }
  let prevCheck = e - BOUNDED_STEP_BYTES
  while (e > s && (bytes[e - 1] === 0x20 || bytes[e - 1] === 0x09 || bytes[e - 1] === 0x0d || bytes[e - 1] === 0x0a)) {
    e -= 1
    if (e <= prevCheck) {
      if (Date.now() >= deadlineMs) return BUDGET_EXHAUSTED_TOKEN
      prevCheck = e - BOUNDED_STEP_BYTES
    }
  }
  return { s, e }
}

function sliceContainsMarker(bytes, start, end, marker, deadlineMs = null) {
  if (deadlineMs === null) {
    const idx = bytes.indexOf(marker, start)
    return idx >= 0 && idx + marker.length <= end
  }
  const overlap = Math.max(0, marker.length - 1)
  for (let pos = start; pos < end; pos += BOUNDED_STEP_BYTES) {
    if (Date.now() >= deadlineMs) return BUDGET_EXHAUSTED_TOKEN
    const windowStart = Math.max(start, pos - overlap)
    const windowEnd = Math.min(pos + BOUNDED_STEP_BYTES, end)
    if (bytes.subarray(windowStart, windowEnd).indexOf(marker) >= 0) return true
  }
  return false
}

function digestSliceBounded(bytes, start, end, deadlineMs) {
  const hash = crypto.createHash('sha256')
  if (deadlineMs === null) {
    hash.update(bytes.subarray(start, end))
    return hash.digest('hex').slice(0, 16)
  }
  for (let pos = start; pos < end; pos += BOUNDED_STEP_BYTES) {
    if (Date.now() >= deadlineMs) return BUDGET_EXHAUSTED_TOKEN
    hash.update(bytes.subarray(pos, Math.min(pos + BOUNDED_STEP_BYTES, end)))
  }
  return hash.digest('hex').slice(0, 16)
}

/**
 * Deadline-checked RFC-8259 JSON parser used for oversized rows (> BOUNDED_STEP_BYTES)
 * when a caller enforces `deadlineMs`. Checks the wall-clock deadline every
 * `BOUNDED_STEP_BYTES` inside large string literals and containers so a single huge row
 * cannot overrun the caller's deadline while still parsing losslessly when budget remains.
 */
function parseJsonSliceBounded(bytes, start, end, deadlineMs) {
  if (deadlineMs === null || end - start <= BOUNDED_STEP_BYTES) {
    if (deadlineMs !== null && Date.now() >= deadlineMs) return BUDGET_EXHAUSTED_TOKEN
    return JSON.parse(bytes.toString('utf8', start, end))
  }
  let pos = start
  let nextCheck = start + BOUNDED_STEP_BYTES

  const checkBudget = () => {
    if (pos >= nextCheck) {
      nextCheck = pos + BOUNDED_STEP_BYTES
      if (Date.now() >= deadlineMs) throw BUDGET_EXHAUSTED_TOKEN
    }
  }
  const skipWs = () => {
    while (pos < end) {
      const b = bytes[pos]
      if (b === 0x20 || b === 0x09 || b === 0x0d || b === 0x0a) {
        pos += 1
        checkBudget()
      } else {
        break
      }
    }
  }
  const readString = () => {
    pos += 1 // opening '"'
    const parts = []
    const decoder = new StringDecoder('utf8')
    let segStart = pos
    while (pos < end) {
      const b = bytes[pos]
      if (b === 0x22) {
        if (pos > segStart) parts.push(decoder.write(bytes.subarray(segStart, pos)))
        const tail = decoder.end()
        if (tail) parts.push(tail)
        pos += 1
        if (Date.now() >= deadlineMs) throw BUDGET_EXHAUSTED_TOKEN
        return parts.length <= 1 ? (parts[0] ?? '') : parts.join('')
      }
      if (b === 0x5c) {
        if (pos > segStart) parts.push(decoder.write(bytes.subarray(segStart, pos)))
        const tail = decoder.end()
        if (tail) parts.push(tail)
        pos += 1
        if (pos >= end) throw new SyntaxError('Unterminated escape')
        const esc = bytes[pos++]
        if (esc === 0x22) parts.push('"')
        else if (esc === 0x5c) parts.push('\\')
        else if (esc === 0x2f) parts.push('/')
        else if (esc === 0x62) parts.push('\b')
        else if (esc === 0x66) parts.push('\f')
        else if (esc === 0x6e) parts.push('\n')
        else if (esc === 0x72) parts.push('\r')
        else if (esc === 0x74) parts.push('\t')
        else if (esc === 0x75) {
          if (pos + 4 > end) throw new SyntaxError('Invalid unicode escape')
          const code = Number.parseInt(bytes.toString('ascii', pos, pos + 4), 16)
          if (!Number.isFinite(code)) throw new SyntaxError('Invalid unicode escape')
          pos += 4
          parts.push(String.fromCharCode(code))
        } else {
          throw new SyntaxError('Invalid escape')
        }
        segStart = pos
        checkBudget()
        continue
      }
      pos += 1
      if (pos >= nextCheck) {
        if (pos > segStart) {
          parts.push(decoder.write(bytes.subarray(segStart, pos)))
          segStart = pos
        }
        nextCheck = pos + BOUNDED_STEP_BYTES
        if (Date.now() >= deadlineMs) throw BUDGET_EXHAUSTED_TOKEN
      }
    }
    throw new SyntaxError('Unterminated string')
  }
  // RFC-8259 numeric literal parser bounded by BOUNDED_STEP_BYTES so a multi-megabyte
  // numeric field cannot overrun deadlineMs; retains enough significant decimal digits
  // and exponent range to preserve IEEE-754 double precision (~17 digits, exponent +-308).
  const readBoundedNumber = (litStart, litEnd) => {
    let p = litStart
    let litCheck = p + BOUNDED_STEP_BYTES
    const checkLit = () => {
      if (p >= litCheck) {
        litCheck = p + BOUNDED_STEP_BYTES
        if (Date.now() >= deadlineMs) throw BUDGET_EXHAUSTED_TOKEN
      }
    }
    const isDigit = (c) => c >= 0x30 && c <= 0x39
    let sign = ''
    if (p < litEnd && bytes[p] === 0x2d) {
      sign = '-'
      p += 1
    }
    if (p >= litEnd) throw new SyntaxError('Invalid number')
    let sig = ''
    let intDigits = 0
    let fracLeadingZeros = 0
    let sawNonZero = false
    if (bytes[p] === 0x30) {
      p += 1
      if (p < litEnd && isDigit(bytes[p])) throw new SyntaxError('Leading zero in number')
    } else if (bytes[p] >= 0x31 && bytes[p] <= 0x39) {
      while (p < litEnd && isDigit(bytes[p])) {
        const d = bytes[p]
        if (sig.length < 25) sig += String.fromCharCode(d)
        sawNonZero = true
        intDigits += 1
        p += 1
        checkLit()
      }
    } else {
      throw new SyntaxError('Invalid number')
    }
    if (p < litEnd && bytes[p] === 0x2e) {
      p += 1
      if (p >= litEnd || !isDigit(bytes[p])) throw new SyntaxError('Invalid fraction')
      while (p < litEnd && isDigit(bytes[p])) {
        const d = bytes[p]
        if (!sawNonZero && d === 0x30) {
          fracLeadingZeros += 1
        } else {
          sawNonZero = true
          if (sig.length < 25) sig += String.fromCharCode(d)
        }
        p += 1
        checkLit()
      }
    }
    let explicitExp = 0
    if (p < litEnd && (bytes[p] === 0x65 || bytes[p] === 0x45)) {
      p += 1
      let expSign = 1
      if (p < litEnd && (bytes[p] === 0x2b || bytes[p] === 0x2d)) {
        if (bytes[p] === 0x2d) expSign = -1
        p += 1
      }
      if (p >= litEnd || !isDigit(bytes[p])) throw new SyntaxError('Invalid exponent')
      let expMag = 0
      while (p < litEnd && isDigit(bytes[p])) {
        if (expMag < 1e9) expMag = expMag * 10 + (bytes[p] - 0x30)
        p += 1
        checkLit()
      }
      explicitExp = expSign * expMag
    }
    if (p !== litEnd) throw new SyntaxError('Invalid number')
    if (!sawNonZero) return sign ? -0 : 0
    const shift = intDigits > 0 ? intDigits - 1 : -(fracLeadingZeros + 1)
    const totalExp = shift + explicitExp
    if (totalExp > 400) return sign ? -Infinity : Infinity
    if (totalExp < -400) return sign ? -0 : 0
    const mantissa = sig.length > 1 ? `${sig[0]}.${sig.slice(1)}` : sig
    return Number(`${sign}${mantissa}e${totalExp}`)
  }
  const readValue = () => {
    skipWs()
    if (pos >= end) throw new SyntaxError('Unexpected end')
    const b = bytes[pos]
    if (b === 0x22) return readString()
    if (b === 0x7b) {
      pos += 1
      const obj = {}
      skipWs()
      if (pos < end && bytes[pos] === 0x7d) {
        pos += 1
        return obj
      }
      while (pos < end) {
        skipWs()
        if (bytes[pos] !== 0x22) throw new SyntaxError('Expected key')
        const key = readString()
        skipWs()
        if (bytes[pos] !== 0x3a) throw new SyntaxError('Expected colon')
        pos += 1
        obj[key] = readValue()
        skipWs()
        if (bytes[pos] === 0x2c) {
          pos += 1
          checkBudget()
          continue
        }
        if (bytes[pos] === 0x7d) {
          pos += 1
          return obj
        }
        throw new SyntaxError('Expected comma or }')
      }
      throw new SyntaxError('Unterminated object')
    }
    if (b === 0x5b) {
      pos += 1
      const arr = []
      skipWs()
      if (pos < end && bytes[pos] === 0x5d) {
        pos += 1
        return arr
      }
      while (pos < end) {
        arr.push(readValue())
        skipWs()
        if (bytes[pos] === 0x2c) {
          pos += 1
          checkBudget()
          continue
        }
        if (bytes[pos] === 0x5d) {
          pos += 1
          return arr
        }
        throw new SyntaxError('Expected comma or ]')
      }
      throw new SyntaxError('Unterminated array')
    }
    const litStart = pos
    while (pos < end) {
      const ch = bytes[pos]
      if (ch === 0x2c || ch === 0x7d || ch === 0x5d || ch === 0x20 || ch === 0x09 || ch === 0x0d || ch === 0x0a) break
      pos += 1
      checkBudget()
    }
    const len = pos - litStart
    if (len === 4 && bytes[litStart] === 0x74 && bytes[litStart + 1] === 0x72 && bytes[litStart + 2] === 0x75 && bytes[litStart + 3] === 0x65) {
      return true
    }
    if (len === 5 && bytes[litStart] === 0x66 && bytes[litStart + 1] === 0x61 && bytes[litStart + 2] === 0x6c && bytes[litStart + 3] === 0x73 && bytes[litStart + 4] === 0x65) {
      return false
    }
    if (len === 4 && bytes[litStart] === 0x6e && bytes[litStart + 1] === 0x75 && bytes[litStart + 2] === 0x6c && bytes[litStart + 3] === 0x6c) {
      return null
    }
    return readBoundedNumber(litStart, pos)
  }
  try {
    const val = readValue()
    skipWs()
    if (pos !== end) throw new SyntaxError('Trailing JSON tokens')
    return val
  } catch (err) {
    if (err === BUDGET_EXHAUSTED_TOKEN) return BUDGET_EXHAUSTED_TOKEN
    throw err
  }
}

/**
 * Null when the file does not end in a complete line (it is being written). A user row
 * is a line whose top-level `role` is "user"; the byte-marker test only skips parsing
 * lines that cannot be one.
 */
function scanTranscript(bytes, { deadlineMs = null } = {}) {
  // Cursor ends every row with a newline: anything after the last one is half written.
  if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) return null
  let turns = 0
  let lastUser = null
  let lastSpan = null
  let lastParsedRow = null
  let lastStart = 0
  let lastNonResumedText = null
  let sawTurnEndedSinceLastNonResumed = false
  let lastNonResumedPrecededByTurnEnded = false
  let sameTurnTypedRowIndex = -1
  let sameTurnOtherRows = []
  const allOtherRows = []
  const userRows = []
  let start = 0
  while (start < bytes.length) {
    if (deadlineMs !== null && Date.now() >= deadlineMs) {
      return { budgetExhausted: true }
    }
    const newline = findByteBounded(bytes, 0x0a, start, bytes.length, deadlineMs)
    if (newline === BUDGET_EXHAUSTED_TOKEN) return { budgetExhausted: true }
    if (newline < 0) return null
    const trimmed = trimSliceBounds(bytes, start, newline, deadlineMs)
    if (trimmed === BUDGET_EXHAUSTED_TOKEN) return { budgetExhausted: true }
    const { s, e } = trimmed
    if (s < e) {
      lastSpan = { s, e }
      lastParsedRow = null
      lastStart = start
      const hasUserMarker = sliceContainsMarker(bytes, s, e, ROLE_USER_MARKER, deadlineMs)
      if (hasUserMarker === BUDGET_EXHAUSTED_TOKEN) return { budgetExhausted: true }
      if (hasUserMarker) {
        let row = null
        try {
          row = parseJsonSliceBounded(bytes, s, e, deadlineMs)
        } catch {
          /* not a whole row */
        }
        if (row === BUDGET_EXHAUSTED_TOKEN) return { budgetExhausted: true }
        lastParsedRow = row
        if (row?.role === 'user') {
          turns += 1
          const userDigest = digestSliceBounded(bytes, s, e, deadlineMs)
          if (userDigest === BUDGET_EXHAUSTED_TOKEN) return { budgetExhausted: true }
          lastUser = userDigest
          const rawText = userRowText(row)
          const kind = userRowKind(rawText)
          const rowIndex = userRows.length
          if (kind !== 'resumed') {
            lastNonResumedText = rawText
            lastNonResumedPrecededByTurnEnded = sawTurnEndedSinceLastNonResumed
            sawTurnEndedSinceLastNonResumed = false
            if (kind === 'typed') {
              sameTurnTypedRowIndex = rowIndex
              sameTurnOtherRows = []
            } else if (kind === 'command_turn' || kind === 'timestamp') {
              sameTurnTypedRowIndex = -1
              sameTurnOtherRows = []
            } else if (kind === 'other') {
              const otherEntry = { rowIndex, digest: lastUser, rawText }
              sameTurnOtherRows.push(otherEntry)
              allOtherRows.push(otherEntry)
            }
          }
          userRows.push({ start, kind, digest: lastUser })
        }
      } else {
        const hasTurnEndedMarker = sliceContainsMarker(bytes, s, e, TURN_ENDED_MARKER, deadlineMs)
        if (hasTurnEndedMarker === BUDGET_EXHAUSTED_TOKEN) return { budgetExhausted: true }
        if (hasTurnEndedMarker) {
          let row = null
          try {
            row = parseJsonSliceBounded(bytes, s, e, deadlineMs)
          } catch {
            /* not a whole row */
          }
          if (row === BUDGET_EXHAUSTED_TOKEN) return { budgetExhausted: true }
          lastParsedRow = row
          if (row?.type === 'turn_ended' && TURN_END_STATUSES.has(row.status)) {
            sawTurnEndedSinceLastNonResumed = true
            sameTurnTypedRowIndex = -1
            sameTurnOtherRows = []
          }
        }
      }
    }
    start = newline + 1
  }
  if (deadlineMs !== null && Date.now() >= deadlineMs) {
    return { budgetExhausted: true }
  }
  let end = null
  let lastLineDigest = null
  if (lastSpan) {
    let row = lastParsedRow
    if (row === null) {
      try {
        row = parseJsonSliceBounded(bytes, lastSpan.s, lastSpan.e, deadlineMs)
      } catch {
        return null
      }
      if (row === BUDGET_EXHAUSTED_TOKEN) return { budgetExhausted: true }
    }
    if (row?.type === 'turn_ended' && TURN_END_STATUSES.has(row.status)) {
      end = {
        status: row.status,
        error: typeof row.error === 'string' && row.error.trim() ? row.error.trim() : null,
      }
    }
    lastLineDigest =
      lastUser !== null && userRows.length > 0 && userRows[userRows.length - 1].start === lastStart
        ? lastUser
        : digestSliceBounded(bytes, lastSpan.s, lastSpan.e, deadlineMs)
    if (lastLineDigest === BUDGET_EXHAUSTED_TOKEN) return { budgetExhausted: true }
  }
  if (deadlineMs !== null && Date.now() >= deadlineMs) {
    return { budgetExhausted: true }
  }
  return {
    turns,
    lastUser,
    end,
    lastLineStart: lastStart,
    lastLineDigest,
    userRows,
    lastNonResumedText,
    lastNonResumedPrecededByTurnEnded,
    sameTurnTypedRowIndex,
    sameTurnOtherRows,
    allOtherRows,
  }
}

function digest(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function extractUserQueryText(rawText) {
  if (typeof rawText !== 'string' || !rawText) return null
  const match = rawText.match(/<user_query>([\s\S]*?)<\/user_query>/)
  return match ? match[1].trim() : null
}

/**
 * The latest non-resumed user row in `transcriptPath`, whether that turn has ended
 * (`ended`: final line is `turn_ended`), and a stable key for it across the whole turn.
 * Only intra-turn `resumed` rows are skipped; a `timestamp`-only wake row is returned
 * as `kind: 'timestamp'` so it never falls back to an earlier typed prompt.
 * Also reports all `typed` user row keys in chronological order (`typedTurnKeys`),
 * whether a `turn_ended` row separated the latest non-resumed row from the turn before it,
 * and `liveTurnTypedKey` when an in-progress non-typed row (`kind: 'other'`, e.g. a
 * mid-turn `<task-notification>`) shares its live turn with an earlier `typed` row.
 * Returns `{ budgetExhausted: true }` when `deadlineMs` expires before a clean read
 * completes, or null when the transcript cannot be read or does not exist yet.
 */
export function activeTranscriptTurn(transcriptPath, { attempts = STABLE_READ_ATTEMPTS, deadlineMs = null } = {}) {
  const conversation = transcriptConversation(transcriptPath)
  if (!conversation) return null
  const read = readTranscriptTurns(transcriptPath, { attempts, deadlineMs })
  if (read?.budgetExhausted) return { budgetExhausted: true }
  if (!read || read.missing) return null
  let lastIndex = -1
  let lastRow = null
  const typedTurnKeys = []
  for (let i = 0; i < read.userRows.length; i += 1) {
    const row = read.userRows[i]
    if (row.kind === 'typed') {
      typedTurnKeys.push(`${conversation}#${i + 1}#${row.digest}`)
    }
    if (row.kind !== 'resumed') {
      lastIndex = i + 1
      lastRow = row
    }
  }
  const sameTurnIdx = typeof read.sameTurnTypedRowIndex === 'number' ? read.sameTurnTypedRowIndex : -1
  const liveTurnTypedKey =
    !read.end &&
    lastRow &&
    lastRow.kind === 'other' &&
    !read.lastNonResumedPrecededByTurnEnded &&
    sameTurnIdx >= 0 &&
    sameTurnIdx < read.userRows.length
      ? `${conversation}#${sameTurnIdx + 1}#${read.userRows[sameTurnIdx].digest}`
      : null
  const sameTurnWakes =
    !read.end && Array.isArray(read.sameTurnOtherRows)
      ? read.sameTurnOtherRows.map((entry) => ({
          key: `${conversation}#${entry.rowIndex + 1}#${entry.digest}`,
          rawText: typeof entry.rawText === 'string' ? entry.rawText : '',
        }))
      : []
  const notificationWakes = Array.isArray(read.allOtherRows)
    ? read.allOtherRows.map((entry) => ({
        key: `${conversation}#${entry.rowIndex + 1}#${entry.digest}`,
        rawText: typeof entry.rawText === 'string' ? entry.rawText : '',
      }))
    : []
  const rawText = typeof read.lastNonResumedText === 'string' ? read.lastNonResumedText : null
  return {
    kind: lastRow ? lastRow.kind : 'none',
    ended: Boolean(read.end),
    key: lastRow ? `${conversation}#${lastIndex}#${lastRow.digest}` : null,
    typedTurnKeys,
    liveTurnTypedKey,
    sameTurnWakes,
    notificationWakes,
    precededByTurnEnded: Boolean(read.lastNonResumedPrecededByTurnEnded),
    stamp: read.stamp,
    turns: read.turns,
    rawText,
    queryText: extractUserQueryText(rawText),
  }
}

/**
 * The identity of the turn that is ending or has just ended in this transcript, as the
 * stop hook and the poller both work it out (see the header), or null when it cannot be
 * read.
 */
export function turnEndIdentity(transcriptPath) {
  const conversation = transcriptConversation(transcriptPath)
  if (!conversation) return null
  const read = readTranscriptTurns(transcriptPath)
  if (!read || read.missing) return null
  return identityOf(conversation, read)
}

function identityOf(conversation, read) {
  const rows = `${conversation}#${read.turns}#${read.lastUser ?? 'none'}`
  // An error or a stop is written before the stop hook runs: its line tells two
  // failures with the same rows apart.
  return read.end && read.end.status !== 'success' ? `${rows}#${read.lastLineDigest}@${read.lastLineStart}` : rows
}

function parseIdentity(identity) {
  const match = /^(.+?)#(\d+)#([0-9a-f]{16}|none)(?:#[0-9a-f]{16}@\d+)?$/.exec(String(identity ?? ''))
  return match ? { conversation: match[1], turns: Number(match[2]), lastUser: match[3] === 'none' ? null : match[3] } : null
}

export function turnBaselinePath(connectionId, dir = CONNECTIONS_DIR) {
  return path.join(dir, `${connectionId}.turn-baseline.json`)
}

/**
 * Note the transcript as it stands as the poller starts tracking a turn (`turn`, the
 * turn marker's `startedAt`): whether Cursor was between turns, how many bytes it keeps
 * when the next turn starts (`kept`: all of it, or all but a final `turn_ended` line)
 * and their digest, and its stamp. With no transcript yet the conversation is between
 * turns with nothing kept. Returns whether that snapshot was written.
 *
 * A transcript that cannot be read cleanly now leaves a pending snapshot instead: the
 * file's stamp as handover found it. completeTurnBaseline takes the snapshot on a later
 * look, but only while the file still has that stamp, so it is the snapshot handover
 * would have taken. Once the file has changed it never is, and that turn's end is not
 * reported from the transcript (as before this existed).
 */
export function recordTurnBaseline(connectionId, { turn, conversationId, transcriptPath = null, dir = CONNECTIONS_DIR } = {}) {
  if (!connectionId || typeof turn !== 'number') return false
  const conversation = transcriptPath ? transcriptConversation(transcriptPath) : conversationId
  if (!conversation || (conversationId && conversation !== conversationId)) return false
  const expect = transcriptPath ? fileStamp(transcriptPath) : null
  const read = transcriptPath ? readTranscriptTurns(transcriptPath) : { missing: true }
  if (!read) {
    writeBaseline(connectionId, dir, { v: 4, turn, conversation, pending: true, transcriptPath, expect })
    return false
  }
  return writeBaseline(connectionId, dir, snapshotOf(turn, conversation, read))
}

function snapshotOf(turn, conversation, read) {
  const between = read.missing ? true : Boolean(read.end)
  const kept = read.missing ? 0 : between ? read.lastLineStart : read.size
  return {
    v: 4,
    turn,
    conversation,
    between,
    kept,
    keptDigest: read.missing ? digest('') : digestBytes(read.bytes.subarray(0, kept)),
    stamp: read.missing ? MISSING_STAMP : read.stamp,
  }
}

function writeBaseline(connectionId, dir, value) {
  try {
    writePrivateJson(turnBaselinePath(connectionId, dir), value)
    return true
  } catch {
    return false
  }
}

/**
 * Take a snapshot handover could not read (recordTurnBaseline), now, if the transcript
 * still has the stamp handover found: then it is the same file, and the snapshot the
 * same. Returns 'complete' (a snapshot exists for `turn`), 'pending' (not taken yet: the
 * read failed again, or the baseline could not be read; try again later), or 'none' (no
 * snapshot for `turn`, and none will be taken: the file has changed, or there never was
 * one).
 */
export function completeTurnBaseline(connectionId, turn, { dir = CONNECTIONS_DIR } = {}) {
  if (!connectionId || typeof turn !== 'number') return 'none'
  const stored = readPrivateJsonResult(turnBaselinePath(connectionId, dir))
  if (stored.status === STATE_ABSENT) return 'none'
  if (stored.status !== STATE_OK) return 'pending'
  const value = stored.value
  if (value?.v !== 4 || value.turn !== turn) return 'none'
  if (!value.pending) return 'complete'
  const { transcriptPath, expect, conversation } = value
  if (typeof transcriptPath !== 'string' || typeof expect !== 'string' || typeof conversation !== 'string') return 'none'
  if (fileStamp(transcriptPath) !== expect) return 'none'
  const read = readTranscriptTurns(transcriptPath)
  if (!read) return 'pending'
  if (read.missing || read.stamp !== expect) return 'none'
  return writeBaseline(connectionId, dir, snapshotOf(turn, conversation, read)) ? 'complete' : 'pending'
}

/** The stamp of a transcript that did not exist yet: any later file differs from it. */
const MISSING_STAMP = 'missing'

function digestBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16)
}

/** The baseline noted for the turn that started at `turn`, or null. */
export function readTurnBaseline(connectionId, turn, { dir = CONNECTIONS_DIR } = {}) {
  if (!connectionId || typeof turn !== 'number') return null
  const value = readPrivateJson(turnBaselinePath(connectionId, dir))
  if (value?.v !== 4 || value.turn !== turn || typeof value.conversation !== 'string') return null
  if (typeof value.between !== 'boolean' || typeof value.stamp !== 'string' || !value.stamp) return null
  if (!Number.isInteger(value.kept) || value.kept < 0 || typeof value.keptDigest !== 'string') return null
  return { turn, conversation: value.conversation, between: value.between, kept: value.kept, keptDigest: value.keptDigest, stamp: value.stamp }
}

/**
 * Whether the turn end in `read` is the tracked command's beyond doubt: conditions (a),
 * (b) and (c) of the header.
 */
function attributable(baseline, read) {
  if (!baseline.between) return false // (a)
  if (read.size < baseline.kept || digestBytes(read.bytes.subarray(0, baseline.kept)) !== baseline.keptDigest) return false // (b)
  if (read.lastLineStart <= baseline.kept) return false // (b): no row written since
  // (c): exactly one turn since, started by the room-command sentence, with only bare
  // timestamps before it and only Cursor's timestamp and resume rows inside it.
  const since = read.userRows.filter((row) => row.start >= baseline.kept)
  const starts = since.filter(startsTurn)
  if (starts.length !== 1 || starts[0].kind !== 'command_turn') return false
  const firstStart = starts[0].start
  return since.every((row) =>
    row.start >= firstStart ? row.kind === 'command_turn' || row.kind === 'timestamp' || row.kind === 'resumed' : row.kind === 'timestamp',
  )
}

/**
 * The first row of the turn a turn end belongs to, from what the file shows: `kind` is
 * 'command' (Cursor's room-command sentence: a room command's turn), 'typed' (a prompt
 * typed at the terminal) or 'unknown' (no first row is visible: the turn wrote none,
 * Cursor's summary turn, a row not known, or the file's position is not known), and
 * `beforeHandover` says the turn was already running when tracking started. The turn's
 * first row is the latest row that starts a turn: since the snapshot, or, when tracking
 * started inside a turn and none has started since, that turn's.
 */
function firstRowOf(baseline, read) {
  const unknown = { kind: 'unknown', beforeHandover: false }
  if (!baseline) return unknown
  if (read.size < baseline.kept || digestBytes(read.bytes.subarray(0, baseline.kept)) !== baseline.keptDigest) return unknown
  const sinceStarts = read.userRows.filter((row) => row.start >= baseline.kept && row.start < read.lastLineStart && startsTurn(row))
  let row = sinceStarts.at(-1)
  let beforeHandover = false
  if (!row && !baseline.between) {
    row = read.userRows.filter((candidate) => candidate.start < baseline.kept && startsTurn(candidate)).at(-1)
    beforeHandover = Boolean(row)
  }
  if (!row) return unknown
  const kind = row.kind === 'command_turn' ? 'command' : row.kind === 'typed' ? 'typed' : 'unknown'
  return { kind, beforeHandover }
}

const CLAIM_SUFFIX = '.claim'
const claimPrefix = (connectionId) => `${connectionId}.turn-end.`

function claimPath(connectionId, identity, dir) {
  const digest = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16)
  return path.join(dir, `${claimPrefix(connectionId)}${digest}${CLAIM_SUFFIX}`)
}

function claimFiles(connectionId, dir, { all = false } = {}) {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(claimPrefix(connectionId)) && (all || name.endsWith(CLAIM_SUFFIX)))
      .map((name) => path.join(dir, name))
  } catch {
    return []
  }
}

/** The version of a claim record; a record of any other shape (an older plugin's) is set aside. */
const CLAIM_VERSION = 3

/**
 * What a claim's owner is doing (see "Reported once" in the header): `report`, the full
 * report of a turn end that is the tracked command's beyond doubt (the stop hook always,
 * the poller when attributed); `notice`, the room told in a message of its own and the
 * working attempt ended, for a turn end the poller cannot tie to the command.
 */
const CLAIM_GOALS = new Set(['report', 'notice'])

/** What already reached DevSpec for a turn end, carried from one owner to the next. */
function progressOf(record) {
  return {
    told: Boolean(record?.told),
    noticed: Boolean(record?.noticed),
    completed: Boolean(record?.completed),
    ended: Boolean(record?.ended),
  }
}

/**
 * A claim record: `record` null when there is none or it is of an older shape (set
 * aside), and `unreadable` when a file is there but could not be read, so what it
 * records is unknown.
 */
function readClaimResult(file) {
  const stored = readPrivateJsonResult(file)
  if (stored.status !== STATE_OK) return { unreadable: stored.status !== STATE_ABSENT, record: null }
  const record = stored.value
  if (record?.v !== CLAIM_VERSION || typeof record.turn !== 'string' || !CLAIM_GOALS.has(record.goal)) {
    return { unreadable: false, record: null }
  }
  return { unreadable: false, record }
}

function readClaim(file) {
  return readClaimResult(file).record
}

/** Whether the process that owns a claim is still running. */
function ownerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Claim one turn end, to report it in full (`goal` 'report') or only to tell the room and
 * end the working attempt (`goal` 'notice'). Returns `{ outcome, told, noticed,
 * completed, ended }`:
 *  - 'claimed': this caller does it. The progress fields say what an earlier owner
 *    already got to DevSpec, so none of it is sent twice: `told` the report's room
 *    message (the failure reply, or its notice when the turn answers no command),
 *    `noticed` a notice of the notice level, `completed` the turn reported finished by
 *    name, `ended` the working attempt ended without a name.
 *  - 'reporting': another live process is doing it now. Leave it: that owner either
 *    settles it or gives it back for a retry (settleTurnEnd).
 *  - 'noticing' (to a `report` caller only): another live process is posting the notice
 *    for it now. The caller answers and closes alongside it, never posting a notice of
 *    its own, and leaves the claim to that owner.
 *  - 'noticed' (to a `notice` caller only): the room was told and the attempt ended. A
 *    `report` caller takes a noticed claim over instead, to answer the command and close
 *    its request: the upgrade.
 *  - 'reported': it has been reported in full.
 *  - 'failed': no claim could be written, so nothing says who reports it.
 * The claim is a file created only if it does not exist yet (a hard link of a complete
 * temporary file), so two processes claiming at once cannot both win. A claim given back,
 * one whose owner process has gone, one of an older shape, and one made before `after`
 * (the tracked turn's start: an earlier turn that wrote no user row of its own) is set
 * aside by a rename only one process can make, and the claim made again. Earlier claims
 * are removed: only the newest turn end can be claimed again.
 */
export function claimTurnEnd(
  connectionId,
  identity,
  { by, goal = 'report', after = null, dir = CONNECTIONS_DIR, now = Date.now(), pid = process.pid } = {},
) {
  const none = progressOf(null)
  if (!connectionId || !parseIdentity(identity) || !CLAIM_GOALS.has(goal)) return { outcome: 'failed', ...none }
  const target = claimPath(connectionId, identity, dir)
  let progress = none
  // Each pass either claims, finds the claim held, or sets a dead claim aside: two passes
  // after setting one aside settle every race between two claimers.
  for (let pass = 0; pass < 3; pass++) {
    const temporary = `${target}.tmp-${pid}-${now.toString(36)}-${pass}`
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const record = { v: CLAIM_VERSION, turn: identity, by: by ?? null, goal, pid, at: new Date(now).toISOString(), state: 'reporting', ...progress }
      fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 })
      try {
        fs.linkSync(temporary, target)
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        const { unreadable, record: existing } = readClaimResult(target)
        // Its progress is unknown, so it is never set aside: the caller tries again later.
        if (unreadable) return { outcome: 'failed', ...none }
        const earlier = typeof after === 'number' && Date.parse(existing?.at ?? '') < after
        if (existing && !earlier) {
          const held = progressOf(existing)
          if (existing.state === 'reported') return { outcome: 'reported', ...held }
          if (existing.state === 'noticed' && goal === 'notice') return { outcome: 'noticed', ...held }
          if (existing.state === 'reporting' && ownerAlive(existing.pid)) {
            const noticing = existing.goal === 'notice' && goal === 'report'
            return { outcome: noticing ? 'noticing' : 'reporting', ...held }
          }
          progress = held
        }
        try {
          fs.renameSync(target, `${target}.aside-${pid}-${now.toString(36)}-${pass}`)
        } catch {
          /* another claimer set it aside first: try the link again */
        }
        continue
      }
    } catch {
      return { outcome: 'failed', ...none }
    } finally {
      try {
        fs.rmSync(temporary, { force: true })
      } catch {
        /* a stray temporary file claims nothing */
      }
    }
    for (const file of claimFiles(connectionId, dir, { all: true })) {
      if (file === target) continue
      try {
        fs.rmSync(file, { force: true })
      } catch {
        /* an older claim left behind matches no newer turn end */
      }
    }
    return { outcome: 'claimed', ...progress }
  }
  return { outcome: 'reporting', ...progress }
}

/** Rewrite this process's own claim of `identity`, if it still holds it. */
function updateOwnClaim(connectionId, identity, dir, patch, pid = process.pid) {
  if (!connectionId || !parseIdentity(identity)) return false
  const target = claimPath(connectionId, identity, dir)
  const record = readClaim(target)
  if (!record || record.pid !== pid || record.turn !== identity) return false
  try {
    writePrivateJson(target, { ...record, ...patch })
    return true
  } catch {
    return false
  }
}

/**
 * The report's room message for this turn end has been posted (the failure reply, or the
 * notice for a turn that answers no command): a later owner does not post it again.
 */
export function noteTurnEndTold(connectionId, identity, { dir = CONNECTIONS_DIR, pid = process.pid } = {}) {
  return updateOwnClaim(connectionId, identity, dir, { told: true }, pid)
}

/** The notice level's message has been posted: no later owner posts a notice again. */
export function noteTurnEndNoticed(connectionId, identity, { dir = CONNECTIONS_DIR, pid = process.pid } = {}) {
  return updateOwnClaim(connectionId, identity, dir, { noticed: true }, pid)
}

/** DevSpec has been told the turn finished, by name: a later owner does not report it again. */
export function noteTurnEndCompleted(connectionId, identity, { dir = CONNECTIONS_DIR, pid = process.pid } = {}) {
  return updateOwnClaim(connectionId, identity, dir, { completed: true }, pid)
}

/** The working attempt has been ended without a name: the notice level does not end it again. */
export function noteTurnEndAttemptEnded(connectionId, identity, { dir = CONNECTIONS_DIR, pid = process.pid } = {}) {
  return updateOwnClaim(connectionId, identity, dir, { ended: true }, pid)
}

/**
 * Settle this process's claim: `reported` when every step of a report reached DevSpec,
 * `noticed` when the notice level's steps did, else given back so the other path, or the
 * poller's next try, does what is left.
 */
export function settleTurnEnd(connectionId, identity, { reported = false, noticed = false, dir = CONNECTIONS_DIR, pid = process.pid } = {}) {
  const state = reported ? 'reported' : noticed ? 'noticed' : 'released'
  return updateOwnClaim(connectionId, identity, dir, { state }, pid)
}

/**
 * Run `report` (an async function) while this process holds the claim of `identity`. If
 * it throws part-way, the claim is given back, keeping the progress already recorded, so
 * the next try, or the other path, does what is left; `onError` hears why. Returns what
 * `report` returns, or 'retry' after a throw.
 */
export async function reportHoldingClaim(connectionId, identity, report, { dir = CONNECTIONS_DIR, pid = process.pid, onError = null } = {}) {
  try {
    return await report()
  } catch (error) {
    settleTurnEnd(connectionId, identity, { dir, pid })
    try {
      onError?.(error)
    } catch {
      /* hearing why is best effort */
    }
    return 'retry'
  }
}

/**
 * How the poller tries again after a report of its own did not reach DevSpec: at most
 * REPORT_ATTEMPTS tries, REPORT_RETRY_MS apart. The spacing is the room post's own
 * 15-second timeout, so a try never overlaps the last; five tries ride out a dropped
 * connection or a DevSpec restart of about a minute, while a post DevSpec refuses is
 * not sent on every lap for ever. After the last try the turn ends as it did before
 * this existed: Working until the next command or the backstop.
 */
export const REPORT_ATTEMPTS = 5
export const REPORT_RETRY_MS = 15_000

/** When the next try is due after `attempts` failed tries, or null when there is none. */
export function nextReportTry(attempts, failedAtMs) {
  return attempts >= REPORT_ATTEMPTS ? null : failedAtMs + REPORT_RETRY_MS
}

/**
 * Whether the end of the turn `baseline` was noted for (a turn's readTurnBaseline) is
 * reported or being reported: a claim in that conversation made after the turn started,
 * reported in full, noticed (its working attempt was ended), or held by a live owner.
 */
export function turnEndClaimed(connectionId, baseline, { dir = CONNECTIONS_DIR } = {}) {
  if (!connectionId || !baseline) return false
  for (const file of claimFiles(connectionId, dir)) {
    const record = readClaim(file)
    const claimed = parseIdentity(record?.turn)
    if (claimed?.conversation !== baseline.conversation || !(Date.parse(record.at) >= baseline.turn)) continue
    if (record.state === 'reported' || record.state === 'noticed') return true
    if (record.state === 'reporting' && ownerAlive(record.pid)) return true
  }
  return false
}

/**
 * How long Cursor must stay idle after a turn end the poller could only notice before
 * the commands picked up before it are answered (the settle point; "Settling and watching" in the
 * header). Measured on CLI 2026.11.19 (2026-11-20, one run each, a background command
 * standing in for the plugin's wake): Cursor started a background command's turn 1.78 s
 * after the command finished while it was idle (idle -> wake turn), and a turn held while
 * another ran 1.46 s after that turn ended normally (normal end -> held turn). After a
 * stop (Ctrl+C) it held the turn indefinitely: nothing in 45 s, nor in 25 s in a second
 * run, where it ran 1.6 s after the person's next typed turn ended. 15 s is over eight
 * times the slowest start seen, so a held turn Cursor starts on its own is seen, and
 * tracked, before the settle point; the room still hears within seconds.
 */
export const SETTLE_MS = 15_000

export function turnSettlePath(connectionId, dir = CONNECTIONS_DIR) {
  return path.join(dir, `${connectionId}.turn-settle.json`)
}

/**
 * Begin settling a turn end the poller noticed (the notice level): `ended` as
 * transcriptTurnEnd returned it, `requests` the request ids of the room commands the
 * settle point may answer, `commands` the commands the tracked turn started with
 * (turn-commands.mjs). `reply` false only watches: no settle point, for a turn whose
 * first row was typed (waiting commands stay open until their own turns run). Returns
 * whether it was written.
 */
export function startSettle(connectionId, { ended, conversation, turn, requests = [], commands = [], reply = true, now = Date.now(), dir = CONNECTIONS_DIR } = {}) {
  if (!connectionId || !ended?.position || !parseIdentity(ended.identity)) return false
  try {
    writePrivateJson(turnSettlePath(connectionId, dir), {
      v: 1,
      identity: ended.identity,
      failure: ended.failure,
      conversation,
      turn,
      requests,
      commands,
      reply: reply !== false,
      resolved: false,
      kept: ended.position.kept,
      keptDigest: ended.position.keptDigest,
      idle: { identity: ended.identity, stamp: ended.position.stamp, since: now },
    })
    return true
  } catch {
    return false
  }
}

/** The settle under way, or null. */
export function readSettle(connectionId, { dir = CONNECTIONS_DIR } = {}) {
  const value = readPrivateJson(turnSettlePath(connectionId, dir))
  if (value?.v !== 1 || !parseIdentity(value.identity) || typeof value.conversation !== 'string') return null
  if (!Number.isInteger(value.kept) || typeof value.keptDigest !== 'string' || typeof value.idle?.stamp !== 'string') return null
  if (typeof value.idle.since !== 'number' || typeof value.idle.identity !== 'string') return null
  return value
}

/** Change the settle under way (its idle point, its base, or that it was resolved). */
export function updateSettle(connectionId, patch, { dir = CONNECTIONS_DIR } = {}) {
  const value = readSettle(connectionId, { dir })
  if (!value) return false
  try {
    writePrivateJson(turnSettlePath(connectionId, dir), { ...value, ...patch })
    return true
  } catch {
    return false
  }
}

export function clearSettle(connectionId, { dir = CONNECTIONS_DIR } = {}) {
  try {
    fs.rmSync(turnSettlePath(connectionId, dir), { force: true })
  } catch {
    /* a settle left behind is cleared by the next handover */
  }
}

/**
 * A turn Cursor started from a background command's output (a room command's wake)
 * since the settle's base, the latest turn there: its start row the room-command
 * sentence, with only Cursor's own rows after it. Returns the snapshot to track it
 * from (as recordTurnBaseline would have taken it just before that row), or null.
 */
function wakeTurnSince(settle, read) {
  if (read.size < settle.kept || digestBytes(read.bytes.subarray(0, settle.kept)) !== settle.keptDigest) return null
  const latest = read.userRows.filter((row) => row.start >= settle.kept && startsTurn(row)).at(-1)
  if (!latest || latest.kind !== 'command_turn') return null
  const kept = latest.start
  return { between: true, kept, keptDigest: digestBytes(read.bytes.subarray(0, kept)), stamp: `settle:${settle.idle.stamp}` }
}

/**
 * What to do next with a settle, from one whole read of the transcript ("Settling and watching" in
 * the header). A read that fails decides nothing.
 *  - `{ action: 'wait' }`
 *  - `{ action: 'track', baseline, startedAt }`: Cursor has started a turn from a
 *    background command's output since: track it as any command's turn, from just
 *    before it, so Working shows while it runs and its end is reported.
 *  - `{ action: 'restart', stamp }`: the same turn end written again (Ctrl+C writes it
 *    twice; a held turn that fails at its very start writes the same line): the idle
 *    clock starts again.
 *  - `{ action: 'resolve' }`: Cursor has been idle at that turn end for SETTLE_MS.
 *  - `{ action: 'rebase', kept, keptDigest, idle }`: another turn (one typed at the
 *    terminal) has ended since: watch from its end, and the idle clock starts again.
 */
export function settleStep(settle, { transcriptPath, now = Date.now() } = {}) {
  if (!settle || !transcriptPath || transcriptConversation(transcriptPath) !== settle.conversation) return { action: 'wait' }
  const read = readTranscriptTurns(transcriptPath)
  if (!read || read.missing) return { action: 'wait' }
  const wake = wakeTurnSince(settle, read)
  if (wake) return { action: 'track', baseline: wake, startedAt: read.end ? Math.min(read.atMs, now) : now }
  // A turn is running that is not a wake's (typed): wait for its end.
  if (!read.end) return { action: 'wait' }
  const identity = identityOf(settle.conversation, read)
  if (identity === settle.idle.identity) {
    if (read.stamp !== settle.idle.stamp) return { action: 'restart', stamp: read.stamp }
    return settle.reply !== false && !settle.resolved && now - settle.idle.since >= SETTLE_MS ? { action: 'resolve' } : { action: 'wait' }
  }
  const position = positionOf(read)
  return { action: 'rebase', kept: position.kept, keptDigest: position.keptDigest, idle: { identity, stamp: read.stamp, since: now } }
}

/**
 * Cheap check, for the poller's once-a-second local check: whether a settle has
 * something to do (its idle clock has run out, or the transcript has changed since
 * its idle point). The lap then decides with settleStep.
 */
export function settleDue({ connectionId, transcriptPath, now = Date.now(), dir = CONNECTIONS_DIR, memo = {} }) {
  const settle = readSettle(connectionId, { dir })
  if (!settle || !transcriptPath) return false
  // Each reason fires once: the clock running out for this idle point, and each change
  // of the file (a turn running changes it often; the lap decides from the next change).
  const clock = `${settle.idle.identity}|${settle.idle.since}`
  if (settle.reply !== false && !settle.resolved && now - settle.idle.since >= SETTLE_MS && memo.clock !== clock) {
    memo.clock = clock
    return true
  }
  const stamp = fileStamp(transcriptPath)
  if (!stamp || stamp === settle.idle.stamp || memo.stamp === stamp) return false
  memo.stamp = stamp
  return true
}

/** Write the snapshot a turn is tracked from, when it is not taken at handover (a settle's track). */
export function writeTurnBaseline(connectionId, { turn, conversation, baseline }, { dir = CONNECTIONS_DIR } = {}) {
  if (!connectionId || typeof turn !== 'number' || !baseline) return false
  return writeBaseline(connectionId, dir, { v: 4, turn, conversation, ...baseline })
}

function fileStampOf({ size, mtimeMs }) {
  return `${size}:${mtimeMs}`
}

function fileStamp(transcriptPath) {
  try {
    return fileStampOf(fs.statSync(transcriptPath))
  } catch {
    return null
  }
}

/**
 * Cheap check, for the poller's once-a-second local check: whether the transcript of a
 * tracked turn has changed to end in a turn end since this was last asked. True once per
 * change; the poller's lap then decides with transcriptTurnEnd. A change is counted as
 * looked at only once its final line was read: after a failed read it is read again on
 * the next check. It also takes a snapshot handover could not read, while it still can
 * (completeTurnBaseline).
 */
export function turnEndPending({ marker, transcriptPath, dir = CONNECTIONS_DIR, connectionId = null, memo = {} }) {
  if (typeof marker?.startedAt !== 'number' || !transcriptPath) return false
  if (connectionId && memo.baseline !== marker.startedAt) {
    if (completeTurnBaseline(connectionId, marker.startedAt, { dir }) !== 'pending') memo.baseline = marker.startedAt
  }
  const stamp = fileStamp(transcriptPath)
  if (!stamp) return false
  const seen = `${marker.startedAt}|${transcriptPath}|${stamp}`
  if (memo.probed === seen) return false
  const last = readLastTurnEnd(transcriptPath)
  if (!last.read) return false
  memo.probed = seen
  return recognisedEnd(last.end)
}

/**
 * The end of the turn `marker` tracks, when the transcript shows one written since
 * tracking started (see the header for every condition), else null:
 * `{ identity, status, error, failure, attributed }`. `attributed` says it is the
 * tracked command's turn end beyond doubt; when false the caller only tells the room
 * about an error or a stop. `memo` (any object the caller keeps) skips a transcript that
 * has not changed since it was last decided.
 *
 * A transcript is recorded as decided only once it was read whole and the answer is
 * that there is nothing to report. A read that failed, a baseline that could not be
 * read, and a turn end handed back to the caller are not recorded, so the next look
 * decides again: the caller's report decides when that turn end is done.
 */
export function transcriptTurnEnd({ connectionId, marker, transcriptPath, dir = CONNECTIONS_DIR, memo = {} }) {
  if (!connectionId || typeof marker?.startedAt !== 'number' || !transcriptPath) return null
  completeTurnBaseline(connectionId, marker.startedAt, { dir })
  const stamp = fileStamp(transcriptPath)
  if (!stamp) return null
  const seen = `${marker.startedAt}|${transcriptPath}|${stamp}`
  if (memo.decided === seen) return null
  const last = readLastTurnEnd(transcriptPath)
  if (!last.read) return null
  const decided = () => {
    memo.decided = seen
    return null
  }
  if (!recognisedEnd(last.end)) return decided()
  const conversation = transcriptConversation(transcriptPath)
  const baseline = readTurnBaseline(connectionId, marker.startedAt, { dir })
  if (baseline && baseline.conversation !== conversation) return decided()
  const read = readTranscriptTurns(transcriptPath)
  // Caught mid-write or unreadable: decided on a later look, never from this one.
  if (!read || read.missing) return null
  if (!read.end) return decided()
  // Written since tracking started: the file changed since, and was last written after
  // the marker. A transcript put back with its old modification time is neither.
  if (read.atMs < marker.startedAt) return decided()
  if (baseline ? read.stamp === baseline.stamp : read.stamp === pendingSnapshotStamp(connectionId, marker.startedAt, dir)) {
    return decided()
  }
  // With no usable snapshot of the turn's start (T8), nothing is the command's beyond
  // doubt, but a fresh error or stop still gets the notice level, as the reader before
  // this one did (item 45eb0708): Working never stays on after Cursor stopped.
  const isAttributed = baseline ? attributable(baseline, read) : false
  // A turn that ran is reported only when it is the tracked command's; otherwise it
  // ends as before this existed.
  if (!isAttributed && read.end.status === 'success') return decided()
  return {
    identity: identityOf(conversation, read),
    status: read.end.status,
    error: read.end.error,
    failure: turnEndFailure(read.end),
    attributed: isAttributed,
    firstRow: isAttributed ? { kind: 'command', beforeHandover: false } : firstRowOf(baseline, read),
    position: positionOf(read),
  }
}

/**
 * Where a turn end sits, for the settle that may follow it (startSettle): the bytes
 * before its line (what Cursor keeps when the next turn starts) and their digest, and
 * the file's stamp.
 */
function positionOf(read) {
  return { kept: read.lastLineStart, keptDigest: digestBytes(read.bytes.subarray(0, read.lastLineStart)), stamp: read.stamp }
}

/** The stamp a pending snapshot found at handover (recordTurnBaseline), or null. */
function pendingSnapshotStamp(connectionId, turn, dir) {
  const value = readPrivateJson(turnBaselinePath(connectionId, dir))
  return value?.v === 4 && value.turn === turn && value.pending && typeof value.expect === 'string' ? value.expect : null
}
